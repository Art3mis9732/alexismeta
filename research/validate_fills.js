"use strict";
/* VALIDATION 3: fill parity. For every position the FORWARD ledger closed, resolve the exit with the replay's own exit rule (simulate.exitOnCandle) on 1m candles, starting at the
 * recorded entry with the recorded stop/target/time exit, and compare with what the live engine recorded:
 *   - exit reason and exit time (within one 1m candle), and exit price (bps) - for positions the engine marked evaluable (no trade-feed gap while open)
 *   - positions with a trade-feed gap are reported SEPARATELY: the engine's own record calls them uncertain, so they are not used to pass or fail the replay
 *   node research/validate_fills.js <forward-db-copy.db> */
const { DatabaseSync } = require("node:sqlite"), H = require("./hist"), { exitOnCandle } = require("./simulate");
function run(dbFile, m1 = null) {
  const db = new DatabaseSync(dbFile, { readOnly: true }); m1 = m1 || {}; for (const s of H.SYMS) if (!m1[s]) m1[s] = H.load1m(s);
  const rows = db.prepare("SELECT * FROM paper_positions WHERE state='CLOSED' ORDER BY opened_ts").all(), out = { db: dbFile, closed_positions: rows.length, evaluable: { checked: 0, same_reason: 0, exit_time_within_1m: 0, price_diffs_bps: [], mismatches: [] }, uncertain: { checked: 0, same_reason: 0, details: [] }, not_covered: 0 };
  for (const r of rows) {
    const sym = r.instrument_id.split(":").pop(), a = m1[sym], tgt = r.evaluable ? out.evaluable : out.uncertain; if (!a || a[0].t > r.opened_ts || a[a.length - 1].t < r.exit_ts) { out.not_covered++; continue; }
    let k = a.findIndex(c => c.t + 60000 > r.opened_ts), res = null;                                     // first candle that has not fully ended before the entry (it may include pre-entry ticks: reported as a limitation)
    const p = { side: r.side, stop: r.stop, target: r.target, time_exit_ts: r.time_exit_ts };
    for (; k < a.length; k++) { const x = exitOnCandle(p, a[k]); if (x) { res = { ...x, t: a[k].t }; break; } if (a[k].t > r.exit_ts + 3600000) break; }
    tgt.checked++; if (!res) { (r.evaluable ? out.evaluable.mismatches : out.uncertain.details).push({ position: r.position_id, recorded: r.exit_reason, replay: "NO_EXIT_FOUND" }); continue; }
    const same = res.reason === r.exit_reason; if (same) tgt.same_reason++;
    const slip = require("../server/risk").RISK_DEFAULTS.slipFrac, rpx = res.px * (1 - r.side * slip);                      // the engine records the exit AFTER slippage, so compare like with like
    const dt = res.t - Math.floor(r.exit_ts / 60000) * 60000, bps = (rpx - r.exit_price) / r.exit_price * 1e4 * r.side;   // positive = replay exit better for the position
    if (r.evaluable) { if (Math.abs(dt) <= 60000) out.evaluable.exit_time_within_1m++; out.evaluable.price_diffs_bps.push(+bps.toFixed(2)); if (!same || Math.abs(dt) > 60000) out.evaluable.mismatches.push({ position: r.position_id, recorded: [r.exit_reason, new Date(r.exit_ts).toISOString(), r.exit_price], replay: [res.reason, new Date(res.t).toISOString(), res.px], ambiguous: res.ambiguous }); }
    else out.uncertain.details.push({ position: r.position_id, recorded: [r.exit_reason, new Date(r.exit_ts).toISOString(), r.exit_price], replay: [res.reason, new Date(res.t).toISOString(), rpx], diff_bps: +bps.toFixed(2), note: r.note });
  }
  db.close(); const e = out.evaluable; out.verdict = e.checked === 0 ? "NO_EVALUABLE_SAMPLE (every closed forward position had a trade-feed gap: the replay can be compared, not validated)" : (e.same_reason === e.checked && e.exit_time_within_1m === e.checked ? "PASS" : "FAIL");
  out.pass = e.checked === 0 ? null : out.verdict === "PASS"; return out;
}
if (require.main === module) console.log(JSON.stringify(run(process.argv[2]), null, 1));
module.exports = { run };
