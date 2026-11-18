"use strict";
/* Per-minute confirmed stress severity for one instrument from 1m candles, using the SAME detector code as the live monitor (server/stress.js) on the minute grid.
 * Price and volume families only: no historical spread/depth exists. Baselines refresh hourly here (every minute live) and the state machine steps once per minute
 * (live: every 5 s), so live would alert somewhat more often; see devdocs/stress-calibration.md. The series for a minute uses only data that had closed by then. */
const S = require("../server/stress"), MIN = 60000, WARM = 1440;
function severitySeries(m1) {
  const idx = new Map(m1.map((x, i) => [x.t, i])), sev = new Int8Array(m1.length).fill(-1), cfg = S.CONFIG;
  let base = null, baseKey = -1, st = S.initialState(m1[0].t);
  for (let i = WARM; i < m1.length; i++) {
    const now = m1[i].t + MIN, ref = Math.floor((now - cfg.baseline.excludeMs) / (60 * MIN)) * 60 * MIN;
    if (ref !== baseKey) { base = S.baselineStats(m1.slice(Math.max(0, i - 1500), i + 1).map(x => ({ t: x.t, c: x.c, v: x.v })), ref, cfg); baseKey = ref; }
    const px = { now: m1[i].c, at: ts => { const j = idx.get(ts - MIN); return j === undefined ? null : m1[j].c; } };
    const recent = m1.slice(i - 19, i + 1).map(x => ({ t: x.t, c: x.c, v: x.v }));
    const pm = S.priceMetrics({ nowTs: now, px, recent, base, cfg }), raw = S.rawSeverity(pm, { S: null, D: null }, cfg);
    st = S.step(st, { ts: now, raw: raw.level, quality: raw.level === null ? "UNRELIABLE" : "VALID", measures: null, reasons: null }, cfg, "x").state; sev[i] = S.SI(st.severity);
  }
  return { t0: m1[0].t, sev };
}
/** gate for the simulator: stress-policy-v1 (asset HIGH+, market-wide when any CRITICAL or two coins HIGH+). unknown (-1) never blocks in this replay (no quality model here). */
function makeGate(series) {
  const at = (sym, t) => { const s = series[sym]; if (!s) return -1; const i = Math.floor((t - s.t0) / MIN) - 1; return i >= 0 && i < s.sev.length ? s.sev[i] : -1; };
  return (sym, t) => { const all = Object.keys(series).map(k => at(k, t)); if (all.some(v => v === 3)) return { block: true, reason: "CRITICAL_MARKET" }; if (all.filter(v => v >= 2).length >= 2) return { block: true, reason: "HIGH_MARKET" }; if (at(sym, t) >= 2) return { block: true, reason: "HIGH_ASSET" }; return { block: false }; };
}
module.exports = { severitySeries, makeGate };
