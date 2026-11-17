"use strict";
/* Stress monitor: the runtime around the pure detector in stress.js. It samples the live collector every evalMs, keeps bounded in-memory
 * buffers, writes append-only transitions and one summary sample per minute, restores its state after a restart, and answers the risk gate.
 *
 * It NEVER touches positions, fills, accounting, the ledger or the policies' inputs. Its only effect on trading is the entry gate, which the
 * engine consults at the final authorisation point; in SHADOW mode (the default) that verdict is recorded but does not block anything.
 *
 * Synthetic scenarios (TEST environment only) replace the measured metrics for ONE instrument and are labelled origin=SYNTHETIC_FIXTURE in
 * every row; the constructor refuses them for any other environment and the database refuses them in a FORWARD file. */
const S = require("./stress");
const { MIN } = S;

const symOf = id => (/([A-Z0-9]+)USDT$/.exec(id) || [null, id])[1];

class StressMonitor {
  constructor({ store, collector, health, now = Date.now, log = () => {}, config = S.CONFIG, mode = "SHADOW", environment = "FORWARD", synthetic = null, instruments = null }) {
    if (!["SHADOW", "ENFORCE"].includes(mode)) throw new Error("stress mode must be SHADOW or ENFORCE");
    if (synthetic && environment !== "TEST") throw new Error("synthetic stress scenarios are allowed in the TEST environment only");
    const dbEnv = store.identity(environment).environment;
    if (dbEnv !== environment) throw new Error(`database environment is ${dbEnv}, stress monitor was started as ${environment}`);
    Object.assign(this, { store, collector, health, now, log, cfg: config, mode, environment, synthetic, db: store.db });
    this.origin = synthetic ? "SYNTHETIC_FIXTURE" : "LIVE";
    this.instrumentIds = instruments || (() => Object.values(collector.idOf));
    this.state = {}; this.ring = {}; this.cache = {}; this.detail = {}; this.lastPersist = {}; this.lastSampleMin = {}; this.timer = null;
    this.started_ts = now(); this.last_tick_ts = null; this.effective_ts = this.started_ts;
    this.st = {
      tr: this.db.prepare(`INSERT INTO stress_transitions (instrument_id, ts, recorded_ts, event_id, kind, from_severity, to_severity, from_quality, to_quality, onset_ts, reason, measures, reasons,
        config_version, policy_version, mode, calibration, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      state: this.db.prepare("INSERT INTO stress_state (instrument_id, state, updated_ts, origin) VALUES (?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET state=excluded.state, updated_ts=excluded.updated_ts, origin=excluded.origin"),
      sample: this.db.prepare("INSERT OR REPLACE INTO stress_samples (instrument_id, ts, spread_bps, depth_bid, depth_ask, depth_min, last, oi, funding, imbalance, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    };
    this.restore();
  }

  // ------------------------------------------------------------------ restart restoration
  /** A restart shorter than maxGapMs resumes the event as it was. A longer gap closes it as UNOBSERVED (we do not know whether it recovered) and starts fresh,
   *  keeping the last valid severity and its time for display. A disconnect must never be recorded as a recovery. */
  restore() {
    const t = this.now();
    for (const r of this.db.prepare("SELECT instrument_id, state, origin FROM stress_state").all()) {
      if (r.origin !== this.origin) continue;                                                // never mix synthetic and live state
      let st; try { st = JSON.parse(r.state); } catch (e) { continue; }
      const gap = t - st.last_eval_ts;
      if (gap > this.cfg.persistence.maxGapMs) {
        const fresh = S.initialState(t);
        if (st.event_id) this.record({ ts: st.last_eval_ts, instrument_id: r.instrument_id, event_id: st.event_id, kind: "EVENT_END_UNOBSERVED", from_severity: st.severity, to_severity: "NORMAL",
          from_quality: st.quality, to_quality: "UNRELIABLE", reason: `monitor not running for ${Math.round(gap / 1000)} s; the event may have ended or continued, it was not observed`, measures: null, reasons: null });
        fresh.last_valid_severity = st.last_valid_severity; fresh.last_valid_ts = st.last_valid_ts; fresh.unobserved_since_ts = st.last_eval_ts;
        this.state[r.instrument_id] = fresh;
      } else this.state[r.instrument_id] = st;
    }
  }

  record(tr) {
    this.st.tr.run(tr.instrument_id, tr.ts, this.now(), tr.event_id || null, tr.kind, tr.from_severity || null, tr.to_severity || null, tr.from_quality || null, tr.to_quality || null,
      tr.onset_ts === undefined ? null : tr.onset_ts, tr.reason || null, tr.measures ? JSON.stringify(tr.measures) : null, tr.reasons ? JSON.stringify(tr.reasons) : null,
      this.cfg.version, S.POLICY_VERSION, this.mode, this.cfg.calibration.status, this.origin);
  }

  // ------------------------------------------------------------------ inputs
  candlesFor(id, t) {
    const c = this.cache[id] || (this.cache[id] = {});
    if (!c.candles || t - c.candles_ts >= 30000) {
      c.candles = this.store.candles(id, "1m", 1500).filter(r => r.final === 1).map(r => ({ t: r.open_ts, c: +r.c, v: +r.base_vol })); c.candles_ts = t;
    }
    return c.candles;
  }
  baselineFor(id, t, state) {
    const c = this.cache[id], ref = S.baselineRefEnd(state, t, this.cfg), key = Math.floor(ref / MIN);
    if (!c.base || c.base_key !== key) { c.base = S.baselineStats(c.candles, key * MIN, this.cfg); c.base_key = key; }
    return c.base;
  }
  liqBaselineFor(id, t, state) {
    const c = this.cache[id], ref = S.baselineRefEnd(state, t, this.cfg), key = Math.floor(ref / MIN);
    if (!c.lbase || c.lbase_key !== key) {
      const rows = this.db.prepare("SELECT spread_bps, depth_min FROM stress_samples WHERE instrument_id=? AND origin=? AND ts>? AND ts<=?")
        .all(id, "LIVE", key * MIN - this.cfg.liquidity.sampleWindowMs, key * MIN);   // samples are always REAL measurements, even on the TEST fixture
      c.lbase = S.liquidityBaseline(rows, this.cfg); c.lbase_key = key;
    }
    return c.lbase;
  }
  seedRing(id, t) {                                                                         // after a restart: exact prices at minute boundaries from final 1m candles
    const r = this.ring[id] = this.ring[id] || [];
    if (r.length) return r;
    for (const x of this.cache[id].candles.filter(x => x.t + MIN > t - 20 * MIN)) r.push({ ts: x.t + MIN, px: x.c, src: "candle" });
    return r;
  }
  depthOf(id) {
    const b = this.collector.books[id];
    if (!b || b.state !== "VALID") return null;
    const tk = this.collector.latestTicker[id]; if (!tk || tk.bid === null || tk.ask === null) return null;
    const bid = +tk.bid, ask = +tk.ask, mid = (bid + ask) / 2, top = b.top(1000);
    const band = L => L.filter(([p]) => Math.abs(+p / mid - 1) * 1e4 <= 10).reduce((a, [p, q]) => a + +p * +q, 0);
    const d = { bid: band(top.bids), ask: band(top.asks) }; d.min = Math.min(d.bid, d.ask); d.imbalance = d.bid + d.ask > 0 ? (d.bid - d.ask) / (d.bid + d.ask) : null; return d;
  }

  // ------------------------------------------------------------------ evaluation
  tick() {
    const t = this.now(); this.last_tick_ts = t;
    for (const id of this.instrumentIds()) { try { this.evaluate(id, t); } catch (e) { this.log(`stress ${id}: ${e.message}`); this.store.feedEvent("stress", "evaluate_failed", `${id}: ${e.message}`); } }
    this.sampleOut(t);
  }
  evaluate(id, t) {
    const cfg = this.cfg, tk = this.collector.latestTicker[id] || null;
    const prev = this.state[id] || (this.state[id] = S.initialState(t));
    const candles = this.candlesFor(id, t), ring = this.seedRing(id, t);
    if (tk && t - tk.recv_ts <= cfg.quality.tickerMaxAgeMs) {
      const bid = tk.bid === null ? null : +tk.bid, ask = tk.ask === null ? null : +tk.ask;
      ring.push({ ts: t, px: +tk.last, src: "ticker", spread: bid && ask ? (ask - bid) / ((ask + bid) / 2) * 1e4 : null });
    }
    while (ring.length && ring[0].ts < t - 20 * MIN) ring.shift();
    const base = this.baselineFor(id, t, prev), lbase = this.liqBaselineFor(id, t, prev);
    const last = ring.length ? ring[ring.length - 1] : null;
    const px = { now: last && t - last.ts <= cfg.quality.tickerMaxAgeMs ? last.px : null, at: (ts, tol) => { let best = null, bd = Infinity; for (const r of ring) { const d = Math.abs(r.ts - ts); if (d < bd) { bd = d; best = r; } } return best && bd <= tol ? best.px : null; } };
    const sp = ring.filter(r => r.ts > t - 30000 && Number.isFinite(r.spread)).map(r => r.spread), spreadNow = sp.length ? S.median(sp) : null;
    const depth = this.depthOf(id);
    let pm = S.priceMetrics({ nowTs: t, px, recent: candles.slice(-20), base, cfg });
    let lm = S.liquidityMetrics({ spreadBps: spreadNow, depthMin: depth ? depth.min : null, lbase, cfg });
    let ov = null;
    if (this.synthetic) { ov = this.synthetic(id, t); if (ov) { pm = { ...pm, ...ov.price, reasons: [] }; lm = { ...lm, ...ov.liquidity, reasons: [] }; } }
    const raw = S.rawSeverity(pm, lm, cfg);
    const hs = this.health.snapshot().feeds.filter(f => f.feed.startsWith(id + "|")), H = {}; for (const f of hs) H[f.kind] = f.state;
    const cov = cached(this.cache[id], "cov", t, 15000, () => ["ticker", "book"].map(k => this.store.coverage(id, k, t - 60000, t)));
    const b = this.collector.books[id], lastC = candles.length ? candles[candles.length - 1] : null;
    let q = S.dataQuality({ tickerAgeMs: tk ? t - tk.recv_ts : null, health: H, bookState: b ? b.state : "UNKNOWN", coverageComplete: cov.every(x => x.complete), priceFamily: pm.P !== null || pm.V !== null,
      liquidityFamily: lm.S !== null || lm.D !== null, candleAgeMs: lastC ? t - (lastC.t + MIN) : null, oiAvailable: !!tk && tk.open_interest !== null }, cfg);
    if (ov && ov.quality) q = { quality: ov.quality, reasons: ov.quality === "VALID" ? [] : ["synthetic scenario: " + ov.quality] };
    const measures = { P: round(pm.P), P_h: pm.P_h || null, P_ret: round(pm.P_ret, 6), dir: pm.dir === undefined ? null : pm.dir, V: round(pm.V), A: round(pm.A), S: round(lm.S), D: round(lm.D), spread_bps: round(spreadNow, 3), depth_min: depth ? Math.round(depth.min) : null, rule: raw.rule };
    const reasons = [...q.reasons, ...pm.reasons, ...lm.reasons];
    const r = S.step(prev, { ts: t, raw: raw.level, quality: q.quality, measures, reasons }, cfg, id);
    for (const tr of r.transitions) this.record(tr);
    this.state[id] = r.state;
    this.detail[id] = { ts: t, measures, levels: S.metricLevels(pm, lm, cfg), raw_level: raw.level, families: raw.families, rule: raw.rule, reasons, quality_reasons: q.reasons, baseline: { n_returns: base.n_returns, sigma_1m: base.sigma_1m, ready: base.ready, ref_end_ts: base.ref_end_ts, med_rv15: base.med_rv15 },
      liquidity_baseline: lbase, horizons: pm.horizons, context: { open_interest: tk && tk.open_interest !== null ? +tk.open_interest : null, funding_rate: tk && tk.funding_rate !== null ? +tk.funding_rate : null,
        next_funding_ts: tk ? tk.next_funding_ts : null, imbalance: depth ? round(depth.imbalance, 3) : null, depth_bid: depth ? Math.round(depth.bid) : null, depth_ask: depth ? Math.round(depth.ask) : null, last: last ? last.px : null }, origin: this.origin };
    const lp = this.lastPersist[id] || 0;
    if (r.transitions.length || t - lp >= 60000) { this.st.state.run(id, JSON.stringify(r.state), t, this.origin); this.lastPersist[id] = t; }
  }
  /** One summary row per instrument per minute: the liquidity baseline of the future, and research evidence. Not per tick. */
  sampleOut(t) {
    const minute = Math.floor(t / MIN) * MIN;
    for (const id of Object.keys(this.detail)) {
      if (this.lastSampleMin[id] === minute) continue;
      const d = this.detail[id], ring = this.ring[id] || [], sp = ring.filter(r => r.ts > t - 60000 && Number.isFinite(r.spread)).map(r => r.spread);
      if (!d.context.last) continue;
      const dmin = d.context.depth_bid !== null ? Math.min(d.context.depth_bid, d.context.depth_ask) : null;
      this.st.sample.run(id, minute, sp.length ? S.median(sp) : null, d.context.depth_bid, d.context.depth_ask, dmin, d.context.last, d.context.open_interest, d.context.funding_rate, d.context.imbalance, "LIVE");
      this.lastSampleMin[id] = minute;
    }
  }
  start() { if (!this.timer) { this.tick(); this.timer = setInterval(() => this.tick(), this.cfg.evalMs); } }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } for (const [id, s] of Object.entries(this.state)) this.st.state.run(id, JSON.stringify(s), this.now(), this.origin); }

  // ------------------------------------------------------------------ outputs
  gate(id, t = this.now()) { return S.entryGate({ states: this.state, instrumentId: id, nowTs: t, mode: this.mode, cfg: this.cfg }); }

  events(limit = 40) {
    const rows = this.db.prepare("SELECT * FROM stress_transitions WHERE event_id IS NOT NULL AND origin=? ORDER BY id").all(this.origin);
    const by = new Map();
    for (const r of rows) {
      const e = by.get(r.event_id) || { event_id: r.event_id, instrument_id: r.instrument_id, onset_ts: null, confirmed_ts: null, end_ts: null, end_reason: null, peak: "NORMAL", config_version: r.config_version, calibration: r.calibration, origin: r.origin, transitions: [] };
      if (r.kind === "EVENT_OPEN") { e.onset_ts = r.onset_ts; e.confirmed_ts = r.ts; }
      if (r.kind === "EVENT_CLOSE") { e.end_ts = r.ts; e.end_reason = r.reason || "RECOVERED"; }
      if (r.kind === "EVENT_END_UNOBSERVED") { e.end_ts = r.ts; e.end_reason = "UNOBSERVED"; e.end_note = r.reason; }
      if (r.to_severity && S.SI(r.to_severity) > S.SI(e.peak)) e.peak = r.to_severity;
      e.transitions.push({ ts: r.ts, kind: r.kind, from: r.from_severity, to: r.to_severity, measures: r.measures ? JSON.parse(r.measures) : null });
      by.set(r.event_id, e);
    }
    return [...by.values()].sort((a, b) => (b.onset_ts || 0) - (a.onset_ts || 0)).slice(0, limit);
  }

  snapshot(t = this.now()) {
    const ids = this.instrumentIds(), lastTr = this.db.prepare("SELECT MAX(ts) AS t FROM stress_transitions WHERE origin=?").get(this.origin).t;
    const insts = ids.map(id => {
      const s = this.state[id] || null, d = this.detail[id] || null, g = this.gate(id, t), known = !!s && s.last_valid_ts !== null;
      const raw = d ? d.raw_level : null, cur = s ? S.SI(s.severity) : 0;
      const trend = !s || raw === null ? { state: "UNKNOWN", basis: "no current measurement" } : s.quality === "UNRELIABLE" ? { state: "UNKNOWN", basis: "data unreliable: no trend is claimed" } : raw > cur ? { state: "WORSENING", basis: "current raw level is above the confirmed level" } : raw < cur ? { state: "IMPROVING", basis: "current raw level is below the confirmed level" } : { state: "STEADY", basis: "raw level equals the confirmed level" };
      return { instrument_id: id, symbol: symOf(id), severity: known ? s.severity : null, severity_known: known, quality: s ? s.quality : "UNRELIABLE", quality_reasons: d ? d.quality_reasons : ["no evaluation yet"],
        since_ts: s ? s.since_ts : null, event: s && s.event_id ? { event_id: s.event_id, onset_ts: s.event_onset_ts, duration_ms: t - s.event_onset_ts, peak: s.peak } : null,
        last_valid: s ? { severity: s.last_valid_severity, ts: s.last_valid_ts } : null, unobserved_since_ts: s && s.unobserved_since_ts ? s.unobserved_since_ts : null, last_eval_ts: s ? s.last_eval_ts : null, trend,
        measures: d ? d.measures : null, levels: d ? d.levels : null, families: d ? d.families : null, rule: d ? d.rule : null, reasons: d ? d.reasons : [], baseline: d ? d.baseline : null, liquidity_baseline: d ? d.liquidity_baseline : null, horizons: d ? d.horizons : [],
        context: d ? d.context : null, gate: g, origin: this.origin };
    });
    return { schema: "stress-api-v1", evaluated_at: t, last_tick_ts: this.last_tick_ts, monitor_age_ms: this.last_tick_ts === null ? null : t - this.last_tick_ts, started_ts: this.started_ts, last_transition_ts: lastTr,
      config: { version: this.cfg.version, calibration: this.cfg.calibration, thresholds: this.cfg.thresholds, horizons_min: this.cfg.horizonsMin, persistence: this.cfg.persistence, baseline: this.cfg.baseline, liquidity: this.cfg.liquidity,
        eval_ms: this.cfg.evalMs, max_detection_delay_ms: this.cfg.maxDetectionDelayMs, mode: this.mode, environment: this.environment, origin: this.origin, mode_effective_ts: this.effective_ts },
      policy: S.POLICY, severities: S.SEVERITIES, instruments: insts, market_wide: insts.some(i => i.gate && i.gate.market_wide), events: this.events(30) };
  }
}

function cached(slot, key, t, ttl, fn) { const k = "_" + key; if (!slot[k] || t - slot[k + "_ts"] >= ttl) { slot[k] = fn(); slot[k + "_ts"] = t; } return slot[k]; }
function round(v, d = 3) { return Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null; }

module.exports = { StressMonitor, symOf };
