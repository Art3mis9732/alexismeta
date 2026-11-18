"use strict";
/* research-prereg-v3: cost-aware entry filter for the three rule analysts (devdocs/research-preregistration-v3.md). RULES FROZEN: the filter only REMOVES entries.
 *   nice node research/run_filter.js [--out file.json] [--seeds 20]                                                                                                              */
const fs = require("node:fs"), path = require("node:path");
const H = require("./hist"), SN = require("./snapshots"), SIM = require("./simulate"), M = require("./metrics"), B = require("./baselines");
const risk = require("../server/risk"), { ANALYSTS, decide } = require("../server/policies"), { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("../tests_js/fixtures/bitget/contracts.json");
const BAR = H.BAR, KS = [2, 3, 4, 5, 6], ROUND_TRIP_BPS = 16, DEV_FRAC = 0.7, MIN_DEV_TRADES = 100, MIN_IMPROVE = 0.02;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

/** wrap any policy so that a setup whose stop is nearer than K x round-trip cost is blocked (K = 0 passes everything). Only ever turns an entry into WAIT. */
function costFilter(policy, K) {
  if (!K) return policy;
  return (a, snap, ctx) => { const d = policy(a, snap, ctx); if (d.intent !== "OPEN_LONG" && d.intent !== "OPEN_SHORT") return d;
    const ref = d.intent === "OPEN_LONG" ? snap.ask : snap.bid, bps = Math.abs(ref - d.setup.stop) / ref * 1e4;
    return bps < K * ROUND_TRIP_BPS ? { analyst: a, intent: "WAIT", code: "COST_FILTER", why: `stop ${bps.toFixed(1)} bps < ${K} x ${ROUND_TRIP_BPS} bps round-trip cost` } : d; };
}
const perDay = (T, key) => { const m = new Map(); for (const t of T) { const k = Math.floor(t.closed_ts / M.DAY); const e = m.get(k) || { r: 0, n: 0 }; e.r += t.R; e.n++; m.set(k, e); } return m; };
/** paired day-block bootstrap of (mean R filtered) - (mean R unfiltered) on the same days, plus each mean's own interval */
function pairedBootstrap(Tf, Tu, { from, to, B: Bn = 2000, seed = 3 }) {
  const f = perDay(Tf), u = perDay(Tu), d0 = Math.floor(from / M.DAY), d1 = Math.floor(to / M.DAY), nd = d1 - d0 + 1, r = M.rng(seed), dif = [], mf = [];
  const at = (m, k) => m.get(d0 + k) || { r: 0, n: 0 };
  for (let b = 0; b < Bn; b++) { let fr = 0, fn = 0, ur = 0, un = 0; for (let i = 0; i < nd; i++) { const k = Math.floor(r() * nd), a = at(f, k), c = at(u, k); fr += a.r; fn += a.n; ur += c.r; un += c.n; } if (fn && un) { dif.push(fr / fn - ur / un); mf.push(fr / fn); } }
  const q = (a, p) => M.quantile(a, p);
  return { improvement_ci95: [q(dif, 0.025), q(dif, 0.975)], filtered_mean_ci95: [q(mf, 0.025), q(mf, 0.975)], resamples: dif.length };
}
const meanR = T => (T.length ? M.mean(T.map(t => t.R)) : null);

function run() {
  const native = {}, m1 = {}, funding = {}, snaps = {}, report = { generated_at: new Date().toISOString(), prereg: "research-prereg-v3", ks: KS, round_trip_bps: ROUND_TRIP_BPS, analysts: {} };
  for (const s of H.SYMS) { native[s] = H.loadNative15(s); m1[s] = H.load1m(s); funding[s] = H.loadFunding(s); }
  const from = Math.max(...H.SYMS.map(s => Math.ceil(m1[s][0].t / BAR) * BAR)), to = Math.min(...H.SYMS.map(s => Math.min(native[s][native[s].length - 1].open_ts + BAR, Math.floor((m1[s][m1[s].length - 1].t + 60000) / BAR) * BAR)));
  for (const s of H.SYMS) { const i0 = native[s].findIndex(r => r.open_ts + BAR >= from), first = Math.max(300, i0), last = native[s].findIndex(r => r.open_ts + BAR === to); snaps[s] = SN.buildAll(s, native[s], { from: first, to: last >= 0 ? last : native[s].length - 1 }).filter(x => x.bar_close_ts >= from && x.bar_close_ts <= to); }
  const split = from + (to - from) * DEV_FRAC, instruments = {}; for (const s of H.SYMS) instruments[s] = fromBitgetContract(CONTRACTS.data.find(c => c.symbol === s), "USDT-FUTURES", Date.now());
  report.window = { from: new Date(from).toISOString(), split: new Date(split).toISOString(), to: new Date(to).toISOString(), days: +((to - from) / M.DAY).toFixed(1) };
  const free = { ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 }, common = { snaps, m1, funding, instruments, from, to, config: free };
  const dev = T => T.filter(t => !t.forced && t.closed_ts < split), fin = T => T.filter(t => !t.forced && t.closed_ts >= split);
  for (const a of ANALYSTS) {
    const sims = {}, rows = {}; for (const K of [0, ...KS]) { sims[K] = SIM.simulate({ analyst: a, ...common, policy: costFilter(decide, K), label: `f${K}:` }); }
    for (const K of [0, ...KS]) { const d = dev(sims[K].trades), f = fin(sims[K].trades); rows[K] = { dev_trades: d.length, dev_mean_R: meanR(d), final_trades: f.length, final_mean_R: meanR(f), blocked_setups: sims[K].counts["decision:COST_FILTER"] || 0 }; }
    const base = rows[0].dev_mean_R, cands = KS.filter(K => rows[K].dev_trades >= MIN_DEV_TRADES && rows[K].dev_mean_R !== null && rows[K].dev_mean_R - base >= MIN_IMPROVE).sort((x, y) => rows[y].dev_mean_R - rows[x].dev_mean_R);
    const K = cands.length ? cands[0] : 0, out = { selected_K: K, selection_basis: cands.length ? `highest development mean R per trade among K with >= ${MIN_DEV_TRADES} trades and >= ${MIN_IMPROVE} R improvement` : "no K improved development mean R by the minimum: registered outcome is no filter", by_K: rows };
    if (K === 0) out.verdict = "REJECTED"; else {
      const Tf = fin(sims[K].trades), Tu = fin(sims[0].trades), pb = pairedBootstrap(Tf, Tu, { from: split, to }), c1 = Tf.length >= 200, c2 = pb.improvement_ci95[0] > 0;
      const rnd = []; for (let k = 0; k < Number(arg("--seeds", 20)); k++) { const setups = sims[K].counts.setup || 1, p = Math.min(0.5, setups / (snaps.BTCUSDT.length * 3)), r = SIM.simulate({ analyst: a, ...common, policy: costFilter(B.randomPolicy(p, 5000 + k), K), label: "rnd:" }); rnd.push(meanR(fin(r.trades))); }
      const p95 = M.quantile(rnd.filter(x => x !== null), 0.95), c3 = c1 && pb.filtered_mean_ci95[0] > 0 && meanR(Tf) > p95;
      out.final = { trades_filtered: Tf.length, trades_unfiltered: Tu.length, mean_R_filtered: meanR(Tf), mean_R_unfiltered: meanR(Tu), ...pb, random_entry_same_filter_mean_R_p95: p95, criteria: { C1_min_200_trades: c1, C2_improvement_ci_lower_gt_0: c2, C3_edge: c3 } };
      out.verdict = c1 && c2 && c3 ? "FILTER_EDGE" : c1 && c2 ? "FILTER_REDUCES_LOSS" : "REJECTED";
    }
    report.analysts[a] = out;
  }
  return report;
}
if (require.main === module) { const r = run(), o = arg("--out", null); if (o) fs.writeFileSync(o, JSON.stringify(r, null, 1)); console.log(JSON.stringify({ window: r.window }));
  for (const a of ANALYSTS) { const x = r.analysts[a]; console.log(a, "K", x.selected_K, x.verdict, x.final ? JSON.stringify({ n: x.final.trades_filtered, filtered_R: +x.final.mean_R_filtered.toFixed(3), unfiltered_R: +x.final.mean_R_unfiltered.toFixed(3), impr_ci: x.final.improvement_ci95.map(v => +v.toFixed(3)), crit: x.final.criteria }) : ""); } }
module.exports = { costFilter, pairedBootstrap, run, KS, ROUND_TRIP_BPS };
