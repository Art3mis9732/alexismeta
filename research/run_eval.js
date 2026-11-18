"use strict";
/* Historical evaluation of the three v1 analysts (candle-only-v1 variant) against baselines, with a stress-gated comparison.
 *   nice -n 10 node research/run_eval.js [--out devdocs/evidence/hist-eval-<date>.json] [--seeds 20]
 * RULES ARE FROZEN: nothing is tuned here. The report is descriptive (thirds + whole window); it is not a profitability claim. See devdocs/research-preregistration.md. */
const fs = require("node:fs"), path = require("node:path");
const H = require("./hist"), SN = require("./snapshots"), SIM = require("./simulate"), M = require("./metrics"), B = require("./baselines"), SS = require("./stress_series");
const risk = require("../server/risk"), { ANALYSTS } = require("../server/policies"), { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("../tests_js/fixtures/bitget/contracts.json");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SEEDS = Number(arg("--seeds", 20)), OUT = arg("--out", null), BAR = H.BAR;

function run() {
  const native = {}, m1 = {}, funding = {}, snaps = {}, report = { generated_at: new Date().toISOString(), variant: SN.VARIANT, microstructure_assumption: SN.MICRO, risk_defaults: risk.RISK_DEFAULTS, data: {}, validation: {}, analysts: {}, baselines: {}, stress_gated: {} };
  for (const s of H.SYMS) { native[s] = H.loadNative15(s); m1[s] = H.load1m(s); funding[s] = H.loadFunding(s); }
  const from = Math.max(...H.SYMS.map(s => Math.ceil(m1[s][0].t / BAR) * BAR)) + 300 * BAR * 0, to = Math.min(...H.SYMS.map(s => Math.min(native[s][native[s].length - 1].open_ts + BAR, Math.floor((m1[s][m1[s].length - 1].t + 60000) / BAR) * BAR)));
  for (const s of H.SYMS) {
    const agg = H.aggregate15(m1[s]); report.data[s] = { native_bars: native[s].length, native_gaps: H.gapsOf(native[s], BAR).length, m1_rows: m1[s].length, m1_gaps: H.gapsOf(m1[s], 60000, "t").length, native_vs_aggregated: H.compareBars(native[s], agg),
      funding_rows: funding[s] ? funding[s].length : 0, funding_from: funding[s] && funding[s].length ? new Date(funding[s][0][0]).toISOString() : null };
    const i0 = native[s].findIndex(r => r.open_ts + BAR >= from), first = Math.max(300, i0), last = native[s].findIndex(r => r.open_ts + BAR === to);
    snaps[s] = SN.buildAll(s, native[s], { from: first, to: last >= 0 ? last : native[s].length - 1 }).filter(x => x.bar_close_ts >= from && x.bar_close_ts <= to);
  }
  const days = (to - from) / M.DAY, instruments = {}; for (const s of H.SYMS) instruments[s] = fromBitgetContract(CONTRACTS.data.find(c => c.symbol === s), "USDT-FUTURES", Date.now());
  report.window = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: +days.toFixed(1), bars_per_coin: snaps.BTCUSDT.length };
  const thirds = [0, 1, 2].map(k => [from + (to - from) * k / 3, from + (to - from) * (k + 1) / 3]);
  // PRIMARY = signal quality: the account-level suspensions (daily loss 2%, drawdown 5% from peak) are OFF, otherwise an analyst that dips 5% early is halted for the rest of the window
  // and its "whole window" would describe only its first weeks (observed in the smoke run). LIVE_RULES = what the live paper account would actually do, including that halt.
  const free = { ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 };
  report.primary_mode = "account suspensions OFF (signal quality); see live_rules for the live behaviour"; report.live_rules = {};
  const common = { snaps, m1, funding, instruments, from, to, config: free }, series = {}; for (const s of H.SYMS) series[s] = SS.severitySeries(m1[s]); const gate = SS.makeGate(series);
  const pack = (sim) => { const T = sim.trades, all = M.summarize(T, { curve: sim.curve, days }), seg = thirds.map(([a, b], k) => ({ third: k + 1, from: new Date(a).toISOString(), ...M.summarize(T.filter(t => t.closed_ts >= a && t.closed_ts < b), { curve: sim.curve.filter(p => p.ts >= a && p.ts < b), days: days / 3 }) }));
    return { whole_window: all, thirds: seg, breakdowns: M.breakdowns(T, {}), uncertainty: M.dayBootstrap(T, { from, to }), counts: sim.counts, trades_sample: T.slice(0, 5).map(t => ({ ...t })) }; };
  const sims = {};
  for (const a of ANALYSTS) { sims[a] = SIM.simulate({ analyst: a, ...common }); report.analysts[a] = pack(sims[a]); const lv = SIM.simulate({ analyst: a, ...common, config: risk.RISK_DEFAULTS, label: "live:" }); report.live_rules[a] = { ...pack(lv), first_suspension_note: "rejections with DRAWDOWN_SUSPENDED / DAILY_LOSS_SUSPENDED are in counts" }; const g = SIM.simulate({ analyst: a, ...common, gate, label: "gated:" }); report.stress_gated[a] = { ungated_net_usdt: report.analysts[a].whole_window.net_usdt, ...pack(g) }; }
  for (const a of ANALYSTS) {                                                                       // baselines with the analyst's own setup frequency
    const setups = sims[a].counts.setup || 1, p = Math.min(0.5, setups / (snaps.BTCUSDT.length * 3)), runs = [];
    for (let k = 0; k < SEEDS; k++) { const r = SIM.simulate({ analyst: a, ...common, policy: B.randomPolicy(p, 1000 + k), label: "rnd:" }); const T = r.trades.filter(t => !t.forced); runs.push({ net: M.sum(T.map(t => t.net)), trades: T.length, R: M.mean(T.map(t => t.R)) }); }
    const tr = SIM.simulate({ analyst: a, ...common, policy: B.trendAlwaysPolicy(), label: "trend:" });
    report.baselines[a] = { no_trade_net_usdt: 0, random_entry: { seeds: SEEDS, entry_probability_per_coin_bar: +p.toFixed(5), net_usdt_p5_p50_p95: [M.quantile(runs.map(x => x.net), 0.05), M.quantile(runs.map(x => x.net), 0.5), M.quantile(runs.map(x => x.net), 0.95)], mean_trades: M.mean(runs.map(x => x.trades)), R_per_trade_p5_p50_p95: [0.05, 0.5, 0.95].map(q => M.quantile(runs.map(x => x.R), q)), note: "R per trade is the comparison unit: net USDT compounds on accounts that fall 60-90% and runs differ in trade count" },
      trend_always: pack(tr).whole_window, analyst_net_usdt: report.analysts[a].whole_window.net_usdt, analyst_trades: report.analysts[a].whole_window.trades };
  }
  report.assumptions = ["candle-only-v1: spread = one tick (measured), depth assumed sufficient, feeds healthy: an UPPER BOUND vs live", "1m candles resolve stop/target order; both touched in one 1m candle => stop (flagged ambiguous)", "funding booked from the public history where it exists (~90 days), otherwise unknown and counted",
    "one portfolio per analyst across BTC/ETH/XRP with the live risk gate, 1,000 USDT start, 2x cap", "rules frozen; nothing tuned on this data; thirds are descriptive", "stress gate: price/volume families only (no historical depth), minute grid, thresholds from devdocs/stress-calibration.md; the evaluation month was already scored three times"];
  return report;
}
if (require.main === module) { const r = run(); if (OUT) fs.writeFileSync(OUT, JSON.stringify(r, null, 1)); const f = x => (x === null || x === undefined ? "n/a" : typeof x === "number" ? +x.toFixed(3) : x);
  console.log(JSON.stringify({ window: r.window, data: Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, { native_gaps: v.native_gaps, m1_gaps: v.m1_gaps, vs_agg: v.native_vs_aggregated }])) }));
  for (const a of ANALYSTS) { const w = r.analysts[a].whole_window, g = r.stress_gated[a].whole_window; console.log(`${a}: trades ${w.trades} win ${f(w.win_rate)} net ${f(w.net_usdt)} USDT exp ${f(w.expectancy_R_per_trade)}R PF ${f(w.profit_factor)} maxDD ${f(w.max_drawdown_pct)}% | gated: trades ${g.trades} net ${f(g.net_usdt)} | boot CI ${JSON.stringify(r.analysts[a].uncertainty.total_net_ci95.map(f))}`); } }
module.exports = { run };
