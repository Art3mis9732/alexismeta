"use strict";
/* cost-filter-shadow-v1: records, for every analyst ENTRY CANDIDATE, what the research-prereg-v3 cost-aware filter WOULD have said, and later the hypothetical result of that candidate.
 * Runs AFTER the decision transaction; a failure is logged and ignored. Reads decisions, writes only its own append-only tables; never touches orders, fills, positions or balances.
 * The rule: block when stop distance in bps < K x round-trip cost in bps. Thresholds K are PREDECLARED (below); the flags for all of them are stored so no threshold is chosen after the fact.
 * Outcomes are HYPOTHETICAL (same exit rule as the replay, on stored final 1m candles): inserted only when the candles cover the trade; a gap is recorded as a gap, never filled. */
const { exitOnCandle } = require("./exit_rule");
const VERSION = "cost-filter-shadow-v1", KS = [2, 3, 4, 5, 6, 8, 10, 12], MIN = 60000, BASIS = "hypothetical: first-touch exit on stored final 1m candles, stop wins a tie, costs = taker + slippage both legs; no order was placed";
const payloadOf = (e) => (e && typeof e.payload === "string" ? JSON.parse(e.payload) : e && e.payload);

class FilterShadow {
  constructor({ db, ledger, config, environment, now = Date.now, log = () => {} }) { Object.assign(this, { db, ledger, config, environment, now, log }); }
  costBps() { return (2 * this.config.taker + 2 * this.config.slipFrac) * 1e4; }
  record({ analyst, instrument_id, decisionId, intent, code, decisionTs, snap }) {
    if (intent !== "OPEN_LONG" && intent !== "OPEN_SHORT") return null;
    const e = this.ledger.get(decisionId), p = payloadOf(e), st = p && p.setup; if (!st || !(snap && snap.ask > 0 && snap.bid > 0)) return null;
    const side = intent === "OPEN_LONG" ? 1 : -1, ref = side > 0 ? snap.ask : snap.bid, stopBps = Math.abs(ref - st.stop) / ref * 1e4, cost = this.costBps(), ratio = stopBps > 0 ? cost / stopBps : null;
    const allow = Object.fromEntries(KS.map(K => [K, stopBps >= K * cost]));
    const dq = { health: snap.health || null, book_state: snap.book_state, coverage_complete: !!snap.coverage_complete, spread_bps: snap.spread_bps ?? null }, rg = { trend_1h: snap.trend_1h, atr_pctile: snap.atr_pctile ?? null, above_vwap: snap.above_vwap ?? null, atr_pct: snap.atr_pct ?? null };
    this.db.prepare(`INSERT OR IGNORE INTO filter_shadow (decision_id, analyst, instrument_id, decision_ts, strategy_version, environment, intent, risk_outcome, side, entry_ref, stop, target, time_exit_ts, stop_bps, est_cost_bps, cost_to_risk, allow_by_k, data_quality, regime, filter_version, created_ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(decisionId, analyst, instrument_id, decisionTs, (e.versions && e.versions.policy) || p.analyst, this.environment, intent, code || null, side, ref, st.stop, st.target, st.time_exit_ts, stopBps, cost, ratio, JSON.stringify(allow), JSON.stringify(dq), JSON.stringify(rg), VERSION, this.now());
    return { stopBps, cost, ratio, allow };
  }
  /** Resolve candidates whose trade window has ended. Idempotent; inserts nothing for a candidate that is still running. */
  resolve() {
    const now = this.now(), rows = this.db.prepare("SELECT * FROM filter_shadow s WHERE NOT EXISTS (SELECT 1 FROM filter_shadow_outcomes o WHERE o.decision_id = s.decision_id)").all(); let n = 0;
    for (const r of rows) {
      const start = Math.floor(r.decision_ts / MIN) * MIN, cs = this.db.prepare("SELECT open_ts, o, h, l, c FROM candles WHERE instrument_id=? AND interval='1m' AND final=1 AND open_ts >= ? ORDER BY open_ts LIMIT 3000").all(r.instrument_id, start);
      const p = { side: r.side, stop: r.stop, target: r.target, time_exit_ts: r.time_exit_ts }; let hit = null, expected = 0, found = 0, contiguous = true, prev = null;
      for (const c of cs) {
        if (prev !== null && c.open_ts - prev !== MIN) { contiguous = false; break; } prev = c.open_ts; found++;
        const x = exitOnCandle(p, { t: c.open_ts, o: +c.o, h: +c.h, l: +c.l, c: +c.c }); if (x) { hit = { ...x, t: c.open_ts }; break; }
      }
      expected = hit ? Math.round((hit.t - start) / MIN) + 1 : Math.max(0, Math.ceil((r.time_exit_ts - start) / MIN) + 1);
      if (hit && contiguous && found === expected) {
        const slip = this.config.slipFrac, taker = this.config.taker, entry = r.entry_ref * (1 + r.side * slip), exit = hit.px * (1 - r.side * slip), net = r.side * (exit - entry) - taker * (entry + exit), riskPx = Math.abs(r.entry_ref - r.stop);
        this.db.prepare("INSERT OR IGNORE INTO filter_shadow_outcomes (decision_id, status, resolved_ts, exit_reason, exit_ts, exit_px, net_r, cost_r, ambiguous, candles_expected, candles_found, basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(r.decision_id, "RESOLVED", now, hit.reason, hit.t, exit, net / riskPx, (r.side * (hit.px - r.entry_ref) - net) / riskPx, hit.ambiguous ? 1 : 0, expected, found, BASIS); n++;
      } else if (!hit && now > r.time_exit_ts + 15 * MIN || (hit === null && !contiguous && now > r.time_exit_ts + 15 * MIN) || (hit && !contiguous && now > hit.t + 15 * MIN)) {
        this.db.prepare("INSERT OR IGNORE INTO filter_shadow_outcomes (decision_id, status, resolved_ts, candles_expected, candles_found, basis) VALUES (?,?,?,?,?,?)").run(r.decision_id, "UNRESOLVED_GAP", now, expected, found, "stored 1m candles do not cover the trade window: no outcome is invented"); n++;
      }
    }
    return n;
  }
  /** per analyst and threshold: candidates allowed/blocked and, among RESOLVED ones, mean hypothetical net R. Counts first, means with their n; no inference. */
  summary() {
    const rows = this.db.prepare("SELECT s.analyst, s.environment, s.allow_by_k, s.stop_bps, s.cost_to_risk, o.status, o.net_r FROM filter_shadow s LEFT JOIN filter_shadow_outcomes o ON o.decision_id = s.decision_id").all(), out = {};
    for (const r of rows) { const a = (out[r.analyst] = out[r.analyst] || { candidates: 0, resolved: 0, unresolved_gap: 0, pending: 0, by_k: {} }); a.candidates++; if (r.status === "RESOLVED") a.resolved++; else if (r.status === "UNRESOLVED_GAP") a.unresolved_gap++; else a.pending++;
      const al = JSON.parse(r.allow_by_k); for (const K of KS) { const b = (a.by_k[K] = a.by_k[K] || { allowed: 0, blocked: 0, allowed_resolved: 0, blocked_resolved: 0, sum_allowed_r: 0, sum_blocked_r: 0 }); const k = al[K] ? "allowed" : "blocked"; b[k]++; if (r.status === "RESOLVED") { b[k + "_resolved"]++; b["sum_" + k + "_r"] += r.net_r; } } }
    for (const a of Object.values(out)) for (const b of Object.values(a.by_k)) { b.mean_r_allowed = b.allowed_resolved ? b.sum_allowed_r / b.allowed_resolved : null; b.mean_r_blocked = b.blocked_resolved ? b.sum_blocked_r / b.blocked_resolved : null; delete b.sum_allowed_r; delete b.sum_blocked_r; }
    return { version: VERSION, thresholds_k: KS, mode: "SHADOW", effect_on_decisions: "NONE", environment_note: "rows carry their database's environment; TEST rows are synthetic fixtures and are never mixed with FORWARD", by_analyst: out };
  }
}
module.exports = { FilterShadow, VERSION, KS };
