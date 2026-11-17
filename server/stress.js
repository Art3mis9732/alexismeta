"use strict";
/* Market-stress detector (stress-v1): pure functions only. No clock, no database, no network, so every number is reproducible from its inputs.
 *
 * DATA CONTRACT (what each measurement is, where it comes from, how fresh it must be)
 *   price      Bitget USDT-perp `last` from the ticker feed, sampled by the monitor every evalMs; seeded after a restart from final 1m
 *              candle CLOSES (exact at minute boundaries). Time = local receive time. Must be < 10 s old (health STALE threshold).
 *   candles1m  final=1 1m trade-price candles from the store (REST-backfilled at start/reconnect, up to 1000 rows). Gaps are COUNTED, never
 *              bridged: a return/rolling window exists only if every minute in it exists.
 *   volume     base-coin volume of the same candles. Rolling 5-minute sum, compared in log space.
 *   spread     (ask-bid)/mid in bps from the ticker. BTC/ETH are usually ONE tick wide, so the baseline dispersion is often zero: a ratio to
 *              the baseline median with an absolute floor is used instead of a z-score.
 *   depth      USDT notional within +/-10 bps of mid on each side, from the full in-memory book. The stored top-20 does not reach 10 bps for
 *              BTC/ETH, so there is no historical depth: the baseline is the monitor's OWN per-minute samples (stress_samples).
 *   context    open interest (base coin, ticker), funding rate, book imbalance. Shown, NEVER used for severity: no validated threshold, funding
 *              interval not stated by the feed, aggressor side unverified (D-008).
 * Missing input never becomes a normal reading: an unavailable family gives severity null (UNKNOWN) when none is available.
 *
 * SEVERITY and DATA QUALITY are separate. Severity is about the market; quality is about whether we can see it.
 * BASELINE excludes the scored window (reference ends `excludeMs` before now) and is FROZEN at the event onset while an event is active.
 * THRESHOLDS are PROVISIONAL unless CONFIG.calibration.status says otherwise; see devdocs/stress-design.md and stress-calibration.md. */

const STRESS_VERSION = "stress-v1", POLICY_VERSION = "stress-policy-v1", MIN = 60000;
const SEVERITIES = Object.freeze(["NORMAL", "ELEVATED", "HIGH_STRESS", "CRITICAL"]);
const QUALITIES = Object.freeze(["VALID", "DEGRADED", "UNRELIABLE"]);
const SI = s => SEVERITIES.indexOf(s);

function deepFreeze(o) { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }

const CONFIG = deepFreeze({
  version: STRESS_VERSION,
  calibration: { status: "PROVISIONAL",
    basis: "price/volatility/volume thresholds = 99.5 / 99.9 / 99.97th percentiles of the metric over 59 development days of public 1m candles (BTC, ETH, XRP pooled), 2026-08-20 to 2026-10-18; liquidity thresholds (S, D) are engineering values with NO historical basis",
    evaluation: "scored on the following 30 days (three times; not a pristine holdout): see devdocs/stress-calibration.md. BTC/ETH: abnormal 60-minute forward ranges followed ELEVATED alerts ~4-5x as often as the base rate; XRP: no lift demonstrated. The detector reacts to moves, it does not anticipate them.",
    note: "PROVISIONAL: modest evidence on one 30-day period, liquidity families unevaluated. Policy stays in SHADOW until validated forward." },
  evalMs: 5000,
  horizonsMin: [1, 5, 15],
  baseline: { windowMs: 24 * 3600000, excludeMs: 15 * MIN, minReturns: 600, sigmaFloor: 2e-5, rv15Floor: 1e-4, lvSigmaFloor: 0.05 },
  liquidity: { minSamples: 360, spreadFloorBps: 0.5, sampleWindowMs: 24 * 3600000 },
  // [ELEVATED, HIGH_STRESS, CRITICAL]; higher is worse except D (depth ratio), where LOWER is worse.
  thresholds: { P: [8.6, 13.9, 19.3], V: [4.7, 8.0, 10.3], A: [3.2, 4.0], S: [3, 5, 8], D: [0.4, 0.25, 0.12] },     // P, V, A: development quantiles (see calibration); S, D: provisional engineering values
  persistence: { escalateMs: 30000, dwellMs: { ELEVATED: 600000, HIGH_STRESS: 900000, CRITICAL: 1200000 }, maxGapMs: 300000 },
  quality: { tickerMaxAgeMs: 10000, candleMaxAgeMs: 180000, monitorStaleMs: 30000, outageMs: 300000, recoveryValidMs: 300000 },
  maxDetectionDelayMs: 60000        // CONFIRMATION delay only: from the first threshold exceedance to a confirmed state (persistence 30 s + evaluation cadence). It is NOT the delay from the start of a move: a move must first grow past the threshold (median 12-15 min into a 15-minute abnormal move in the evaluation month).
});

/* ---------------------------------------------------------------- statistics */
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function robustSigma(a) { const m = median(a); if (m === null) return null; return 1.4826 * median(a.map(x => Math.abs(x - m))); }

/* ---------------------------------------------------------------- baselines */
/** Baseline from FINAL 1m candles (ascending, {t: open_ts, c, v}). Only data that ended at or before refEndTs and within the window is used. */
function baselineStats(candles, refEndTs, cfg = CONFIG) {
  const B = cfg.baseline, lo = refEndTs - B.windowMs;
  const c = candles.filter(x => x.t + MIN <= refEndTs && x.t + MIN > lo);
  const rets = new Array(c.length).fill(null);
  for (let i = 1; i < c.length; i++) if (c[i].t - c[i - 1].t === MIN && c[i].c > 0 && c[i - 1].c > 0) rets[i] = Math.log(c[i].c / c[i - 1].c);
  const flat = rets.filter(x => x !== null), rv15 = [], lv5 = [];
  for (let i = 15; i < c.length; i += 5) {                          // 15 consecutive 1m returns = 16 contiguous candles; rets[k] is null across any gap
    let ok = true, ss = 0;
    for (let k = i - 14; k <= i; k++) { if (rets[k] === null) { ok = false; break; } ss += rets[k] * rets[k]; }
    if (ok) rv15.push(Math.sqrt(ss));
  }
  for (let i = 4; i < c.length; i++) { if (c[i].t - c[i - 4].t !== 4 * MIN) continue; let s = 0; for (let k = i - 4; k <= i; k++) s += c[k].v; if (s > 0) lv5.push(Math.log(s)); }
  const sig = robustSigma(flat);
  return { ref_end_ts: refEndTs, n_returns: flat.length, sigma_1m: sig === null ? null : Math.max(B.sigmaFloor, sig),
    n_rv15: rv15.length, med_rv15: rv15.length ? Math.max(B.rv15Floor, median(rv15)) : null,
    n_lv5: lv5.length, lv5_med: lv5.length ? median(lv5) : null, lv5_sigma: lv5.length ? Math.max(B.lvSigmaFloor, robustSigma(lv5)) : null,
    ready: flat.length >= B.minReturns };
}

/** Liquidity baseline from the monitor's own per-minute samples [{spread_bps, depth_min}] (may contain nulls). */
function liquidityBaseline(samples, cfg = CONFIG) {
  const sp = samples.map(s => s.spread_bps).filter(Number.isFinite), dp = samples.map(s => s.depth_min).filter(Number.isFinite);
  return { n_spread: sp.length, n_depth: dp.length, med_spread: sp.length >= cfg.liquidity.minSamples ? median(sp) : null, med_depth: dp.length >= cfg.liquidity.minSamples ? median(dp) : null };
}

/* ---------------------------------------------------------------- measurements */
/** @param px   {now: price now, at(ts, tolMs) -> price|null}   @param recent final 1m candles ascending (latest last)  @param nowTs ms */
function priceMetrics({ nowTs, px, recent, base, cfg = CONFIG }) {
  const out = { P: null, V: null, A: null, horizons: [], reasons: [] };
  if (!base || !base.ready) { out.reasons.push(`baseline not ready (${base ? base.n_returns : 0} < ${cfg.baseline.minReturns} contiguous 1m returns)`); return out; }
  for (const h of cfg.horizonsMin) {
    const then = px.at(nowTs - h * MIN, Math.max(6000, h * MIN * 0.1));
    if (!(then > 0) || !(px.now > 0)) { out.reasons.push(`price ${h}m ago unavailable`); continue; }
    const r = Math.log(px.now / then), z = Math.abs(r) / (base.sigma_1m * Math.sqrt(h));
    out.horizons.push({ h, ret: r, z });
  }
  if (out.horizons.length) { const top = out.horizons.reduce((a, b) => (b.z > a.z ? b : a)); out.P = top.z; out.P_h = top.h; out.dir = Math.sign(top.ret); out.P_ret = top.ret; }
  const n = recent.length, latest = n ? recent[n - 1] : null;
  if (latest && nowTs - (latest.t + MIN) <= cfg.quality.candleMaxAgeMs) {
    let ok = n >= 16, ss = 0;
    if (ok) for (let i = n - 15; i < n; i++) { if (recent[i].t - recent[i - 1].t !== MIN) { ok = false; break; } const r = Math.log(recent[i].c / recent[i - 1].c); ss += r * r; }
    if (ok && base.med_rv15) { out.RV15 = Math.sqrt(ss); out.V = out.RV15 / base.med_rv15; } else out.reasons.push("realised volatility: fewer than 15 contiguous final 1m returns");
    if (n >= 5 && latest.t - recent[n - 5].t === 4 * MIN && base.lv5_med !== null) { let s = 0; for (let i = n - 5; i < n; i++) s += recent[i].v; if (s > 0) { out.v5 = s; out.A = (Math.log(s) - base.lv5_med) / base.lv5_sigma; } }
    else out.reasons.push("volume: fewer than 5 contiguous final 1m candles");
  } else out.reasons.push("latest final 1m candle is too old for volatility/volume");
  return out;
}
function liquidityMetrics({ spreadBps, depthMin, lbase, cfg = CONFIG }) {
  const out = { S: null, D: null, reasons: [] };
  if (!lbase || lbase.med_spread === null) out.reasons.push(`spread baseline warming up (${lbase ? lbase.n_spread : 0}/${cfg.liquidity.minSamples} samples)`);
  else if (Number.isFinite(spreadBps)) out.S = spreadBps / Math.max(lbase.med_spread, cfg.liquidity.spreadFloorBps);
  else out.reasons.push("spread unavailable now");
  if (!lbase || lbase.med_depth === null) out.reasons.push(`depth baseline warming up (${lbase ? lbase.n_depth : 0}/${cfg.liquidity.minSamples} samples)`);
  else if (Number.isFinite(depthMin)) out.D = depthMin / lbase.med_depth;
  else out.reasons.push("depth unavailable now (book not valid)");
  return out;
}

/* ---------------------------------------------------------------- severity rules (stress-v1)
 *   price family  = max(level(P), level(V)); P and V are two views of the same price path, so they are ONE family, not two confirmations
 *   activity      = level(A) in 0..2; volume only CONFIRMS price (it cannot raise severity on its own beyond what it adds below)
 *   liquidity     = max(level(S), level(D))
 *   ELEVATED     price>=1 OR liquidity>=1
 *   HIGH_STRESS  price>=2 OR liquidity>=2 OR (price>=1 AND activity>=2)
 *   CRITICAL     price>=3 OR (price>=2 AND liquidity>=2)
 * Unavailable families are ignored for the level but reported; if NO family is available the level is null (unknown), never NORMAL. */
const lvHi = (v, t) => (Number.isFinite(v) ? t.filter(x => v >= x).length : null);
const lvLo = (v, t) => (Number.isFinite(v) ? t.filter(x => v <= x).length : null);
const mx = (...a) => { const b = a.filter(x => x !== null); return b.length ? Math.max(...b) : null; };
function rawSeverity(pm, lm, cfg = CONFIG) {
  const th = cfg.thresholds;
  const price = mx(lvHi(pm.P, th.P), lvHi(pm.V, th.V)), activity = lvHi(pm.A, th.A), liq = mx(lvHi(lm.S, th.S), lvLo(lm.D, th.D));
  const fam = { price: { level: price, available: price !== null }, activity: { level: activity, available: activity !== null }, liquidity: { level: liq, available: liq !== null } };
  if (price === null && liq === null) return { level: null, families: fam, rule: "no price or liquidity family available" };
  const p = price || 0, a = activity || 0, l = liq || 0;
  let level = 0, rule = "all available families below ELEVATED";
  if (p >= 1 || l >= 1) { level = 1; rule = p >= 1 ? "price/volatility family >= ELEVATED" : "liquidity family >= ELEVATED"; }
  if (p >= 2 || l >= 2 || (p >= 1 && a >= 2)) { level = 2; rule = p >= 2 ? "price/volatility family >= HIGH" : l >= 2 ? "liquidity family >= HIGH" : "price >= ELEVATED confirmed by abnormal volume"; }
  if (p >= 3 || (p >= 2 && l >= 2)) { level = 3; rule = p >= 3 ? "price/volatility family >= CRITICAL" : "price >= HIGH together with liquidity >= HIGH"; }
  return { level, families: fam, rule };
}

/** Level (0..3, or null when unavailable) of every individual measurement, so a display can show WHY without re-implementing thresholds. */
function metricLevels(pm, lm, cfg = CONFIG) {
  const th = cfg.thresholds; return { P: lvHi(pm.P, th.P), V: lvHi(pm.V, th.V), A: lvHi(pm.A, th.A), S: lvHi(lm.S, th.S), D: lvLo(lm.D, th.D) };
}

/* ---------------------------------------------------------------- data quality */
/** q: {tickerAgeMs, health:{ticker,books,trade}, bookState, coverageComplete, priceFamily:bool, liquidityFamily:bool, candleAgeMs, oiAvailable} */
function dataQuality(q, cfg = CONFIG) {
  const bad = [], soft = [];
  const never = q.tickerAgeMs === null || q.tickerAgeMs === undefined;          // null <= x is TRUE in JavaScript: a ticker that never arrived must not look fresh
  if (never || !(q.tickerAgeMs <= cfg.quality.tickerMaxAgeMs)) bad.push(`ticker ${never ? "never received" : Math.round(q.tickerAgeMs / 1000) + " s old"}`);
  for (const k of ["ticker", "books", "trade"]) if ((q.health || {})[k] !== "HEALTHY") bad.push(`${k} feed ${(q.health || {})[k] || "UNKNOWN"}`);
  if (q.bookState !== "VALID") bad.push(`order book ${q.bookState || "UNKNOWN"}`);
  if (!q.coverageComplete) bad.push("coverage gap in the last minute");
  if (!q.priceFamily) soft.push("price baseline or recent candles unavailable");
  if (!q.liquidityFamily) soft.push("liquidity baseline warming up or book values unavailable");
  if (q.candleAgeMs !== null && q.candleAgeMs !== undefined && q.candleAgeMs > cfg.quality.candleMaxAgeMs) soft.push(`last final 1m candle ${Math.round(q.candleAgeMs / 1000)} s old`);
  if (!q.oiAvailable) soft.push("open interest missing");
  const quality = bad.length ? "UNRELIABLE" : !q.priceFamily ? "UNRELIABLE" : soft.length ? "DEGRADED" : "VALID";
  return { quality, reasons: [...bad, ...soft] };
}

/* ---------------------------------------------------------------- state machine */
function initialState(ts) {
  return { severity: "NORMAL", quality: "UNRELIABLE", since_ts: ts, event_id: null, event_onset_ts: null, peak: "NORMAL", up_since: null, up_min: null, down_since: null, down_max: null,
    last_eval_ts: ts, last_valid_severity: null, last_valid_ts: null, valid_since_ts: null, unusable_since_ts: ts, recovery_until: null };
}
function baselineRefEnd(state, nowTs, cfg = CONFIG) { return (state.event_onset_ts !== null && state.event_onset_ts !== undefined ? state.event_onset_ts : nowTs) - cfg.baseline.excludeMs; }

/** One evaluation. obs = {ts, raw: level|null, quality, measures, reasons}. Returns {state, transitions}. Pure: returns new objects. */
function step(prev, obs, cfg = CONFIG, instrumentId = "?") {
  const s = { ...prev }, T = [], ts = obs.ts, P = cfg.persistence;
  const mk = (kind, extra = {}) => T.push({ ts, instrument_id: instrumentId, event_id: s.event_id, kind, from_severity: prev.severity, to_severity: s.severity,
    from_quality: prev.quality, to_quality: s.quality, measures: obs.measures || null, reasons: obs.reasons || null, ...extra });
  s.quality = obs.quality; s.last_eval_ts = ts;
  const cur = SI(s.severity);
  if (obs.quality !== "UNRELIABLE" && obs.raw !== null) {
    const raw = obs.raw;
    if (raw > cur) {                                              // escalation needs persistence; the confirmed level is the lowest raw level seen while pending
      s.down_since = s.down_max = null;
      if (s.up_since === null) { s.up_since = ts; s.up_min = raw; } else s.up_min = Math.min(s.up_min, raw);
      if (ts - s.up_since >= P.escalateMs) {
        const to = s.up_min, onset = s.up_since;
        s.severity = SEVERITIES[to]; s.up_since = s.up_min = null;
        if (cur === 0) { s.event_id = `stress:${instrumentId}:${Math.floor(onset / MIN) * MIN}`; s.event_onset_ts = onset; s.peak = s.severity; s.since_ts = ts; mk("EVENT_OPEN", { onset_ts: onset }); }
        else { if (to > SI(s.peak)) s.peak = s.severity; s.since_ts = ts; mk("ESCALATE"); }
      }
    } else if (raw < cur) {                                       // recovery needs a dwell at the CURRENT level; steps down to the highest raw level seen meanwhile
      s.up_since = s.up_min = null;
      if (s.down_since === null) { s.down_since = ts; s.down_max = raw; } else s.down_max = Math.max(s.down_max, raw);
      if (ts - s.down_since >= P.dwellMs[s.severity]) {
        const to = s.down_max; s.severity = SEVERITIES[to]; s.down_since = s.down_max = null; s.since_ts = ts;
        if (to === 0) { mk("EVENT_CLOSE", { reason: "RECOVERED" }); s.event_id = null; s.event_onset_ts = null; s.peak = "NORMAL"; } else mk("DEESCALATE");
      }
    } else { s.up_since = s.up_min = s.down_since = s.down_max = null; }
    s.last_valid_severity = s.severity; s.last_valid_ts = ts;
  } else { s.up_since = s.up_min = s.down_since = s.down_max = null; }   // unreliable or unknown: severity is RETAINED, nothing escalates or recovers
  // Outages: a brief UNRELIABLE spell (a websocket reconnect: the 60 s coverage rule that the risk gate already applies) needs no extra waiting. After a REAL outage
  // (>= outageMs, which includes a monitor that was not running) entries stay blocked until the data has been usable for recoveryValidMs.
  if (obs.quality === "UNRELIABLE") { if (s.unusable_since_ts === null || s.unusable_since_ts === undefined) s.unusable_since_ts = ts; }
  else if (s.unusable_since_ts !== null && s.unusable_since_ts !== undefined) { if (ts - s.unusable_since_ts >= cfg.quality.outageMs) s.recovery_until = ts + cfg.quality.recoveryValidMs; s.unusable_since_ts = null; }
  // "usable" = not UNRELIABLE. DEGRADED (e.g. the liquidity baseline is still warming up after a fresh start) is usable; counting it as unusable would block every entry for hours.
  s.valid_since_ts = obs.quality !== "UNRELIABLE" ? (prev.valid_since_ts === null ? ts : prev.valid_since_ts) : null;
  if (prev.quality !== s.quality) mk("QUALITY_CHANGE");
  return { state: s, transitions: T };
}

/* ---------------------------------------------------------------- risk policy (stress-policy-v1) */
const POLICY = deepFreeze({
  version: POLICY_VERSION,
  mode_default: "SHADOW",
  summary: "Stress can only BLOCK NEW paper entries. It never closes, reduces or re-prices an open position, never touches accounting, stops, targets or time exits, and never changes size.",
  table: [
    { state: "NORMAL", scope: "-", new_entries: "no change", exposure: "no change", existing_positions: "managed as always", recovery: "-" },
    { state: "ELEVATED", scope: "affected asset", new_entries: "allowed (warning only in v1)", exposure: "no change", existing_positions: "managed as always", recovery: "dwell below ELEVATED for 10 min" },
    { state: "HIGH_STRESS", scope: "affected asset; ALL assets when 2 or more are HIGH_STRESS or worse", new_entries: "BLOCKED", exposure: "no change (no reduction rule in v1)", existing_positions: "managed as always (stops, targets, time exits, funding, accounting)", recovery: "dwell below HIGH for 15 min" },
    { state: "CRITICAL", scope: "ALL assets (BTC, ETH and XRP are one correlated bucket)", new_entries: "BLOCKED", exposure: "no change (no reduction rule in v1)", existing_positions: "managed as always", recovery: "dwell below CRITICAL for 20 min" },
    { state: "DATA UNRELIABLE (quality)", scope: "affected asset", new_entries: "BLOCKED", exposure: "no change", existing_positions: "retained with their last valid timestamps; no fabricated exit", recovery: "data usable again; after an outage of 5 minutes or more (including a monitor that was not running) it must stay usable for 5 more minutes. Brief reconnects only need the 60 s coverage rule the risk gate already applies" },
    { state: "UNKNOWN (no stress state / stale monitor / warm-up)", scope: "affected asset", new_entries: "BLOCKED when enforced", exposure: "no change", existing_positions: "managed as always", recovery: "monitor evaluating again with VALID or DEGRADED quality" }
  ],
  not_implemented: ["exposure reduction", "forced exits", "size scaling", "extra confirmation requirements for entries", "automatic training or model replacement (never)"]
});

/** Entry gate. states: {instrumentId: state-with-last_eval_ts, ...}. mode SHADOW records the verdict without blocking; ENFORCE blocks. */
function entryGate({ states, instrumentId, nowTs, mode = "SHADOW", cfg = CONFIG }) {
  const base = { policy: POLICY_VERSION, stress_version: STRESS_VERSION, mode, enforced: mode === "ENFORCE", evaluated_ts: nowTs };
  const st = states[instrumentId];
  const done = (would_block, code, scope, detail, extra = {}) => ({ ...base, would_block, code, scope, detail, severity: st ? st.severity : null, quality: st ? st.quality : null, ...extra });
  if (!st) return done(true, "STRESS_UNKNOWN", "asset", "no stress state for this instrument");
  if (!(nowTs - st.last_eval_ts <= cfg.quality.monitorStaleMs)) return done(true, "STRESS_MONITOR_STALE", "asset", `last evaluation ${Math.round((nowTs - st.last_eval_ts) / 1000)} s ago`);
  if (st.quality === "UNRELIABLE") return done(true, "STRESS_DATA_UNRELIABLE", "asset", "market data unreliable for this instrument");
  const all = Object.values(states), crit = all.filter(x => x.severity === "CRITICAL").length, high = all.filter(x => SI(x.severity) >= 2).length;
  if (crit >= 1) return done(true, "STRESS_CRITICAL_MARKET", "market", `${crit} instrument(s) CRITICAL`, { market_wide: true });
  if (high >= 2) return done(true, "STRESS_HIGH_MARKET", "market", `${high} instruments HIGH_STRESS or worse`, { market_wide: true });
  if (SI(st.severity) >= 2) return done(true, "STRESS_HIGH_ASSET", "asset", "instrument is HIGH_STRESS");
  if (st.recovery_until !== null && st.recovery_until !== undefined && nowTs < st.recovery_until) return done(true, "STRESS_RECOVERY_WINDOW", "asset", "recovering from a data outage of 5 minutes or more: data must stay usable for 5 minutes");
  return done(false, null, "-", st.severity === "ELEVATED" ? "ELEVATED: warning only" : "no restriction");
}

module.exports = { STRESS_VERSION, POLICY_VERSION, SEVERITIES, QUALITIES, CONFIG, POLICY, MIN, SI, median, robustSigma, baselineStats, liquidityBaseline, priceMetrics, liquidityMetrics,
  rawSeverity, metricLevels, dataQuality, initialState, baselineRefEnd, step, entryGate, deepFreeze };
