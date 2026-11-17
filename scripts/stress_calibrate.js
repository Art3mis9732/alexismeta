"use strict";
/* Calibrate and evaluate the PRICE and VOLUME families of stress-v1 on public 1m history (scripts/stress_fetch_1m.js).
 *   node scripts/stress_calibrate.js [--out devdocs/evidence/stress-calibration-<date>.json]
 *
 * What this can and cannot establish
 *   - Thresholds are chosen from empirical quantiles on the DEVELOPMENT period only (first 60 of 90 days, minus a 24 h baseline warm-up).
 *   - The EVALUATION period (last 30 days) is not looked at until the thresholds are fixed. It is scored once, with the final thresholds.
 *   - "Abnormal" is labelled by something the detector never computes: the FORWARD 60-minute realised range (max high - min low over the next
 *     60 minutes, as a fraction of price), against an absolute cut-off taken from the development period's own distribution (99th percentile).
 *   - Liquidity (spread, depth) is NOT evaluated: no historical order-book data exists. Those families are provisional and shadow-only.
 *   - The state machine runs on a 60 s grid here; live it runs every 5 s with a 30 s persistence requirement, so live will alert slightly MORE
 *     often. The shadow forward run is what measures the real rate. Baselines are refreshed hourly here (every minute live).
 *   - No accuracy percentage is produced. Reported: alert frequency, time under restriction, detection delay, missed labelled episodes,
 *     conditional frequency of abnormal forward ranges with a Wilson interval, and sensitivity to scaling the thresholds. */
const fs = require("node:fs"), path = require("node:path");
const S = require("../server/stress");
const MIN = 60000, DAY = 86400000, SYMS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"], HIST = path.join(__dirname, "..", "data", "hist");
const FWD = 60, WARM = 24 * 60;

function load(sym) {
  const rows = JSON.parse(fs.readFileSync(path.join(HIST, `1m_${sym}.json`), "utf8"));
  return rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function wilson(k, n) { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; }

/** per-minute measurements exactly as the live detector defines them (price/volume families). Index i = the candle that just closed. */
function measure(candles, cfg) {
  const idx = new Map(candles.map((x, i) => [x.t, i])), P = new Array(candles.length).fill(null), V = P.slice(), A = P.slice(), Dir = P.slice();
  let base = null, baseKey = -1;
  for (let i = WARM; i < candles.length; i++) {
    const now = candles[i].t + MIN, ref = Math.floor((now - cfg.baseline.excludeMs) / (60 * MIN)) * 60 * MIN;       // baseline refreshed hourly here
    if (ref !== baseKey) { base = S.baselineStats(candles.slice(Math.max(0, i - 1500), i + 1), ref, cfg); baseKey = ref; }
    const px = { now: candles[i].c, at: ts => { const j = idx.get(ts - MIN); return j === undefined ? null : candles[j].c; } };
    const pm = S.priceMetrics({ nowTs: now, px, recent: candles.slice(i - 19, i + 1), base, cfg });
    P[i] = pm.P; V[i] = pm.V; A[i] = pm.A; Dir[i] = pm.dir === undefined ? null : pm.dir;
  }
  return { P, V, A, Dir };
}
function fwdRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i + FWD < candles.length; i++) { let hi = -Infinity, lo = Infinity; for (let k = i + 1; k <= i + FWD; k++) { hi = Math.max(hi, candles[k].h); lo = Math.min(lo, candles[k].l); } out[i] = (hi - lo) / candles[i].c; }
  return out;
}
/** run the state machine over [from, to) on the minute grid -> confirmed-severity series + events */
function simulate(candles, m, from, to, cfg, id) {
  let st = S.initialState(candles[from].t), sev = new Array(candles.length).fill(0), tr = [];
  for (let i = from; i < to; i++) {
    const th = cfg.thresholds, lq = { S: null, D: null }, raw = S.rawSeverity({ P: m.P[i], V: m.V[i], A: m.A[i] }, lq, cfg);
    const r = S.step(st, { ts: candles[i].t + MIN, raw: raw.level, quality: raw.level === null ? "UNRELIABLE" : "VALID", measures: null, reasons: null }, cfg, id);
    st = r.state; tr.push(...r.transitions); sev[i] = S.SI(st.severity);
  }
  return { sev, tr };
}
const withThresholds = (cfg, th) => S.deepFreeze({ ...JSON.parse(JSON.stringify(cfg)), thresholds: th });
const scale = (th, f) => ({ P: th.P.map(x => x * f), V: th.V.map(x => x * f), A: th.A.map(x => x * f), S: th.S, D: th.D });

/** SECOND, move-onset label for LATENCY: an abnormal 15-minute move = |15m log return| >= the development-period 99.9th percentile of |15m return| for that instrument
 *  (absolute, not volatility-normalised, so it is not the detector's own measure). Onset = the start of that 15-minute window. */
function moveLabels(candles) { const r = new Array(candles.length).fill(null); for (let i = 15; i < candles.length; i++) r[i] = Math.abs(Math.log(candles[i].c / candles[i - 15].c)); return r; }
function moveScore(candles, sev, r15, cut15, from, to) {
  const ev = []; let cur = null;
  for (let i = from; i < to; i++) if (r15[i] !== null && r15[i] >= cut15) { if (cur && i - cur.end <= 30) cur.end = i; else { cur = { start: i, end: i }; ev.push(cur); } }
  const delays = []; let hit = 0;
  for (const e of ev) {
    const onset = e.start - 15; let at;
    for (let i = Math.max(from, onset - 5); i <= e.end + 15 && i < to; i++) if (sev[i] >= 1) { at = i; break; }
    if (at !== undefined) { hit++; delays.push(at - onset); }
  }
  return { cutoff_abs_15m_return: +cut15.toFixed(5), events: ev.length, detected: hit, missed: ev.length - hit, missed_rate: ev.length ? +((ev.length - hit) / ev.length).toFixed(3) : null,
    delay_from_move_start_min: { median: delays.length ? quantile(delays, 0.5) : null, p90: delays.length ? quantile(delays, 0.9) : null, note: "negative = the alert preceded the start of the 15-minute window" } };
}
function episodes(label, mergeMin = FWD) {                                  // maximal runs of abnormal-forward-range minutes, merged when closer than mergeMin
  const ep = []; let cur = null;
  for (let i = 0; i < label.length; i++) if (label[i]) { if (cur && i - cur.end <= mergeMin) cur.end = i; else { cur = { start: i, end: i }; ep.push(cur); } }
  return ep;
}
function score(candles, sev, label, from, to, id) {
  const ep = episodes(label.map((x, i) => (i >= from && i < to ? x : false))), days = (to - from) / 1440;
  let alertMin = [0, 0, 0, 0], hit = 0, delays = [], alerts = [];
  for (let i = from; i < to; i++) alertMin[sev[i]]++;
  for (let i = from + 1; i < to; i++) if (sev[i] >= 1 && sev[i - 1] === 0) alerts.push(i);                 // alert episode starts (leaving NORMAL)
  for (const e of ep) { const hitAt = alerts.find(a => a >= e.start - 15 && a <= e.end) ?? (sev[e.start] >= 1 ? e.start : undefined); if (hitAt !== undefined) { hit++; delays.push(hitAt - e.start); } }
  let trueAlerts = 0; for (const a of alerts) if (ep.some(e => a + FWD >= e.start && a <= e.end)) trueAlerts++;
  const cond = [0, 1, 2, 3].map(L => { let k = 0, n = 0; for (let i = from; i < to; i++) if (sev[i] === L && label[i] !== null) { n++; if (label[i]) k++; } return { level: S.SEVERITIES[L], minutes: n, abnormal_forward_range: k, frequency: n ? k / n : null, wilson95: wilson(k, n) }; });
  const baseK = (() => { let k = 0, n = 0; for (let i = from; i < to; i++) if (label[i] !== null) { n++; if (label[i]) k++; } return { n, k, rate: k / n }; })();
  return { days: +days.toFixed(1), alert_episodes: alerts.length, alert_episodes_per_day: +(alerts.length / days).toFixed(3), minutes_by_state: Object.fromEntries(S.SEVERITIES.map((s, L) => [s, alertMin[L]])),
    share_of_time_restricted_pct: +(100 * (alertMin[2] + alertMin[3]) / (to - from)).toFixed(3), labelled_episodes: ep.length, detected: hit, missed: ep.length - hit,
    missed_rate: ep.length ? +((ep.length - hit) / ep.length).toFixed(3) : null, median_detection_delay_min: delays.length ? quantile(delays, 0.5) : null, delay_minutes_p90: delays.length ? quantile(delays, 0.9) : null,
    alert_episodes_overlapping_a_labelled_episode: trueAlerts, alert_episodes_without_one: alerts.length - trueAlerts, base_rate_abnormal_forward_range: baseK, conditional_on_state: cond };
}

(async () => {
  const cfg = S.CONFIG, out = { generated_at: new Date().toISOString(), config_version: cfg.version, method: "see header of scripts/stress_calibrate.js", instruments: {} };
  const data = Object.fromEntries(SYMS.map(s => [s, load(s)])), meas = {}, fr = {};
  for (const s of SYMS) { const c = data[s]; meas[s] = measure(c, cfg); fr[s] = fwdRange(c); }
  const N = data.BTCUSDT.length, split = N - 30 * 1440, devFrom = WARM, devTo = split - FWD;           // dev ends FWD minutes before the split: forward labels never reach into the evaluation period
  // ---- 1. thresholds from DEVELOPMENT quantiles (pooled across instruments; metrics are already scale-free)
  const pool = k => SYMS.flatMap(s => meas[s][k].slice(devFrom, devTo)).filter(Number.isFinite);
  const Q = { E: 0.995, H: 0.999, C: 0.9997 };
  const r1 = x => Math.round(x * 10) / 10;                                  // thresholds are shipped rounded to one decimal; the evaluation below uses exactly the shipped values
  const th = { P: [quantile(pool("P"), Q.E), quantile(pool("P"), Q.H), quantile(pool("P"), Q.C)].map(r1), V: [quantile(pool("V"), Q.E), quantile(pool("V"), Q.H), quantile(pool("V"), Q.C)].map(r1),
    A: [quantile(pool("A"), Q.E), quantile(pool("A"), Q.H)].map(r1), S: cfg.thresholds.S, D: cfg.thresholds.D };
  out.development = { period: [new Date(data.BTCUSDT[devFrom].t).toISOString(), new Date(data.BTCUSDT[devTo].t).toISOString()], quantiles: Q, thresholds_chosen: { P: th.P.map(r), V: th.V.map(r), A: th.A.map(r) },
    note: "Liquidity thresholds (S, D) are NOT calibrated: no historical depth exists. They are provisional engineering values and shadow-only." };
  const tuned = withThresholds(cfg, th);
  // ---- 2. labels: absolute cut-off from the dev distribution of forward ranges (per instrument), applied everywhere
  const cut = {}, label = {};
  for (const s of SYMS) { cut[s] = quantile(fr[s].slice(devFrom, devTo).filter(Number.isFinite), 0.99); label[s] = fr[s].map(x => (x === null ? null : x >= cut[s])); }
  out.labels = { definition: `forward ${FWD}-minute realised range >= the 99th percentile of that instrument's development-period distribution`, cutoff_fraction: Object.fromEntries(SYMS.map(s => [s, +cut[s].toFixed(5)])) };
  // ---- 3. DEVELOPMENT scoring (for transparency) and the ONE evaluation scoring with the final thresholds
  const r15 = {}, cut15 = {};
  for (const s of SYMS) { r15[s] = moveLabels(data[s]); cut15[s] = quantile(r15[s].slice(devFrom, devTo).filter(Number.isFinite), 0.999); }
  for (const s of SYMS) {
    const c = data[s], sc = (f, a, b) => { const cc = f === 1 ? tuned : withThresholds(tuned, scale(th, f)), sim = simulate(c, meas[s], a, b, cc, "bitget:perp:" + s); return score(c, sim.sev, label[s], a, b, s); };
    const simD = simulate(c, meas[s], devFrom, devTo, tuned, 'x'), simE = simulate(c, meas[s], split, N - FWD, tuned, 'x');
    out.instruments[s] = { development: sc(1, devFrom, devTo), evaluation: sc(1, split, N - FWD), move_onset_latency: { development: moveScore(c, simD.sev, r15[s], cut15[s], devFrom, devTo), evaluation: moveScore(c, simE.sev, r15[s], cut15[s], split, N - FWD) }, sensitivity_evaluation: Object.fromEntries([0.8, 1.25, 1.5].map(f => [`thresholds_x${f}`, (({ alert_episodes_per_day, missed_rate, share_of_time_restricted_pct, alert_episodes_without_one }) => ({ alert_episodes_per_day, missed_rate, share_of_time_restricted_pct, alert_episodes_without_one }))(sc(f, split, N - FWD))])) };
  }
  out.evaluation_period = [new Date(data.BTCUSDT[split].t).toISOString(), new Date(data.BTCUSDT[N - FWD].t).toISOString()];
  out.limitations = ["Price and volume families only; liquidity families unevaluated (no historical order book).", "Labels are forward realised range (volatility), not direction and not 'crashes'; they measure whether abnormal conditions followed an alert.",
    "Minute grid vs 5 s live evaluation: live alerts more often. Baselines refreshed hourly here.", "Overlapping labels: effective sample size is far below the minute counts; Wilson intervals are optimistic.", "One 30-day evaluation period: no claim about other regimes.", "No accuracy percentage is produced."];
  const file = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ thresholds: out.development.thresholds_chosen, labels: out.labels.cutoff_fraction, evaluation: Object.fromEntries(SYMS.map(s => [s, (({ alert_episodes_per_day, share_of_time_restricted_pct, labelled_episodes, detected, missed_rate, median_detection_delay_min, alert_episodes_without_one }) => ({ alert_episodes_per_day, share_of_time_restricted_pct, labelled_episodes, detected, missed_rate, median_detection_delay_min, alert_episodes_without_one }))(out.instruments[s].evaluation)])) }, null, 1));
  function r(x) { return +x.toFixed(3); }
})();
