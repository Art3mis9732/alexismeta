"use strict";
/* Post-hoc DIAGNOSIS of research-prereg-v3 (descriptive, supplementary; the registered verdicts are not changed): why K=6, why < 200 trades, thinning vs selection, which winners were blocked, portfolio survival,
 * and the same K grid under FIXED sizing (no compounding), which removes the Risk Taker depletion artefact. Uses the existing replay; no new parameter search.  node research/analyze_v3.js [--out file] */
const fs = require("node:fs"), H = require("./hist"), SN = require("./snapshots"), SIM = require("./simulate"), M = require("./metrics"), { costFilter, KS, ROUND_TRIP_BPS } = require("./run_filter");
const risk = require("../server/risk"), { ANALYSTS, decide } = require("../server/policies"), { fromBitgetContract } = require("../server/instruments"), CONTRACTS = require("../tests_js/fixtures/bitget/contracts.json");
const BAR = H.BAR, arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const stopBps = t => Math.abs(t.entry - t.stop) / t.entry * 1e4, mean = a => (a.length ? M.mean(a) : null), sum = a => a.reduce((x, y) => x + y, 0);
function run() {
  const native = {}, m1 = {}, funding = {}, snaps = {};
  for (const s of H.SYMS) { native[s] = H.loadNative15(s); m1[s] = H.load1m(s); funding[s] = H.loadFunding(s); }
  const from = Math.max(...H.SYMS.map(s => Math.ceil(m1[s][0].t / BAR) * BAR)), to = Math.min(...H.SYMS.map(s => Math.min(native[s][native[s].length - 1].open_ts + BAR, Math.floor((m1[s][m1[s].length - 1].t + 60000) / BAR) * BAR)));
  for (const s of H.SYMS) { const i0 = native[s].findIndex(r => r.open_ts + BAR >= from), first = Math.max(300, i0), last = native[s].findIndex(r => r.open_ts + BAR === to); snaps[s] = SN.buildAll(s, native[s], { from: first, to: last >= 0 ? last : native[s].length - 1 }).filter(x => x.bar_close_ts >= from && x.bar_close_ts <= to); }
  const split = from + (to - from) * 0.7, instruments = {}; for (const s of H.SYMS) instruments[s] = fromBitgetContract(CONTRACTS.data.find(c => c.symbol === s), "USDT-FUTURES", Date.now());
  const free = { ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 }, base = { snaps, m1, funding, instruments, from, to, config: free }, out = { window: { from: new Date(from).toISOString(), split: new Date(split).toISOString(), to: new Date(to).toISOString() }, analysts: {} };
  const dev = T => T.filter(t => !t.forced && t.closed_ts < split), fin = T => T.filter(t => !t.forced && t.closed_ts >= split);
  for (const a of ANALYSTS) {
    const comp = SIM.simulate({ analyst: a, ...base, label: "c:" }), fx = {}; for (const K of [0, ...KS.filter(k => k <= 6)]) fx[K] = SIM.simulate({ analyst: a, ...base, fixedSizing: true, policy: costFilter(decide, K), label: `x${K}:` });
    const T0 = comp.trades.filter(t => !t.forced), rej = Object.fromEntries(Object.entries(comp.counts).filter(([k]) => k.startsWith("risk_reject:")));
    const o = { survival_compounding_K0: { start: 1000, end_cash: +comp.end_cash.toFixed(2), min_equity: +comp.min_equity.toFixed(2), trades_dev: dev(comp.trades).length, trades_final: fin(comp.trades).length, risk_rejections: rej, last_trade_risk_usdt: T0.length ? +T0[T0.length - 1].risk_usdt.toFixed(4) : null, first_trade_risk_usdt: T0.length ? +T0[0].risk_usdt.toFixed(4) : null }, stop_bps_quantiles_unfiltered_fixed: {}, by_K_fixed_sizing: {} };
    const U = fx[0].trades.filter(t => !t.forced), sb = U.map(stopBps).sort((x, y) => x - y); o.stop_bps_quantiles_unfiltered_fixed = { p10: sb[Math.floor(sb.length * 0.1)], p50: sb[Math.floor(sb.length * 0.5)], p90: sb[Math.floor(sb.length * 0.9)], share_ge_96bps_dev: dev(U).filter(t => stopBps(t) >= 96).length / Math.max(1, dev(U).length), share_ge_96bps_final: fin(U).filter(t => stopBps(t) >= 96).length / Math.max(1, fin(U).length) };
    for (const K of [0, 2, 3, 4, 5, 6]) {
      const F = fx[K].trades.filter(t => !t.forced), thr = K * ROUND_TRIP_BPS, blocked = U.filter(t => stopBps(t) < thr), allowed = U.filter(t => stopBps(t) >= thr);
      const row = (T) => ({ n: T.length, mean_R: mean(T.map(t => t.R)), total_R: sum(T.map(t => t.R)) });
      o.by_K_fixed_sizing[K] = { dev_filtered: row(dev(F)), final_filtered: row(fin(F)), final_unfiltered: row(fin(U)), blocked_final_from_unfiltered_path: row(fin(blocked)), allowed_final_from_unfiltered_path: row(fin(allowed)),
        blocked_share_of_all_trades_final: fin(blocked).length / Math.max(1, fin(U).length), winners_blocked_final: { n: fin(blocked).filter(t => t.R > 0).length, of_all_winners: fin(U).filter(t => t.R > 0).length, sum_positive_R_blocked: sum(fin(blocked).filter(t => t.R > 0).map(t => t.R)), sum_positive_R_all: sum(fin(U).filter(t => t.R > 0).map(t => t.R)) },
        gross_R_mean_blocked_final: mean(fin(blocked).map(t => t.R + (t.fees + t.slippage_cost * 0) / t.risk_usdt)), cost_R_mean_blocked_final: mean(fin(blocked).map(t => (t.fees) / t.risk_usdt)), cost_R_mean_allowed_final: mean(fin(allowed).map(t => (t.fees) / t.risk_usdt)) };
    }
    out.analysts[a] = o;
  }
  return out;
}
if (require.main === module) { const r = run(), o = arg("--out", null); if (o) fs.writeFileSync(o, JSON.stringify(r, null, 1)); console.log("done", o || ""); }
module.exports = { run };
