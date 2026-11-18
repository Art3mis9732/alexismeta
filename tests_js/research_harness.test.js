"use strict";
/* Research harness tests. SYNTHETIC data only (no data/hist dependence: that directory is gitignored and absent on CI).
 * They pin the properties the evaluation's honesty depends on: exits and costs follow the live rules, the stop wins an ambiguous 1m candle,
 * nothing before a decision is changed by the future, account suspensions switch behaviour, and the statistics are deterministic. */
const test = require("node:test"), assert = require("node:assert/strict");
const risk = require("../server/risk"), { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");
const { simulate } = require("../research/simulate"), M = require("../research/metrics"), H = require("../research/hist"), B = require("../research/baselines");
const BAR = 900000, MIN = 60000, T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const inst = { BTCUSDT: fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", Date.now()) };

function snap(t, px) { return { instrument_id: "bitget:perp:BTCUSDT", bar_close_ts: t, close: px, bid: px, ask: px, spread_bps: 0.02, atr: 100, atr_pct: 0.15, atr_pctile: 0.5, trend_1h: 1, above_vwap: true, change_24h: 0,
  book_state: "VALID", coverage_complete: true, coverage_reasons: [], depth_10bps: { bid: 1e7, ask: 1e7 }, health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY" } }; }
/** n flat 1m candles at price px starting at t; overrides[k] replaces candle k */
function flat(t, n, px, over = {}) { return Array.from({ length: n }, (_, k) => ({ t: t + k * MIN, o: px, h: px, l: px, c: px, v: 1, ...(over[k] || {}) })); }
/** policy that opens a LONG at the first bar only */
function once(stopDist, tgtDist, exitBars = 20) { let done = false; return (a, s) => { if (done) return { analyst: a, intent: "WAIT", code: "DONE" }; done = true;
  return { analyst: a, intent: "OPEN_LONG", code: "SETUP", setup: { stop: s.ask - stopDist, target: s.ask + tgtDist, time_exit_ts: s.bar_close_ts + exitBars * BAR, trigger: "T" } }; }; }
const run = (m1rows, policy, extra = {}) => simulate({ analyst: "balanced", snaps: { BTCUSDT: [snap(T0 + BAR, 60000), snap(T0 + 2 * BAR, 60000)] }, m1: { BTCUSDT: m1rows }, funding: { BTCUSDT: [[T0 - 86400000, 0.0001], [T0 + 9 * 3600000, 0.0001]] },
  instruments: inst, policy, ...extra });

test("target exit: filled at the target then slipped; fees on both legs; net identity holds", () => {
  const m1 = flat(T0, 60, 60000, { 20: { h: 60300 } }), r = run(m1, once(200, 300));
  assert.equal(r.trades.length, 1); const t = r.trades[0], slip = risk.RISK_DEFAULTS.slipFrac;
  assert.equal(t.reason, "target"); assert.ok(Math.abs(t.exit - 60300 * (1 - slip)) < 1e-6);
  assert.ok(Math.abs(t.entry - 60000 * (1 + slip)) < 1e-6);
  assert.ok(Math.abs(t.net - (t.gross - t.fees + t.funding)) < 1e-9);
  assert.ok(t.fees > 0 && t.net < t.gross);
});
test("stop and target both touched inside ONE 1m candle: the STOP is assumed and the trade is flagged ambiguous", () => {
  const m1 = flat(T0, 60, 60000, { 20: { h: 60300, l: 59790 } }), r = run(m1, once(200, 300));
  assert.equal(r.trades[0].reason, "stop"); assert.equal(r.trades[0].ambiguous, true); assert.ok(r.trades[0].net < 0);
});
test("a gap through the stop fills at the candle open (worse than the stop), never at the stop", () => {
  const m1 = flat(T0, 60, 60000, { 20: { o: 59500, h: 59500, l: 59400, c: 59450 } }), r = run(m1, once(200, 300)), t = r.trades[0];
  assert.equal(t.reason, "stop"); assert.ok(t.exit < 59800 && Math.abs(t.exit - 59500 * (1 - risk.RISK_DEFAULTS.slipFrac)) < 1e-6);
});
test("time exit fills at the first 1m open at/after the exit time", () => {
  const snaps = [1, 2, 3, 4, 5].map(i => snap(T0 + i * BAR, 60000));
  const r = simulate({ analyst: "balanced", snaps: { BTCUSDT: snaps }, m1: { BTCUSDT: flat(T0, 60 * 6, 60000) }, funding: {}, instruments: inst, policy: once(5000, 5000, 2) }), t = r.trades[0];
  assert.equal(t.reason, "time_exit"); assert.equal(t.closed_ts, T0 + 3 * BAR);
});
test("no look-ahead: the entry is identical whatever happens AFTER the decision", () => {
  const a = run(flat(T0, 80, 60000, { 30: { h: 60300 } }), once(200, 300)).trades[0], b = run(flat(T0, 80, 60000, { 30: { l: 59000, o: 59000 } }), once(200, 300)).trades[0];
  for (const k of ["entry", "qty", "stop", "target", "opened_ts", "risk_usdt"]) assert.equal(a[k], b[k], k);
});
test("risk sizing is the live rule: risk_usdt is the analyst's fraction of equity", () => {
  const t = run(flat(T0, 60, 60000), once(200, 300)).trades[0]; assert.ok(t.risk_usdt <= 1000 * risk.RISK_DEFAULTS.riskPerTrade.balanced * 1.0001 && t.risk_usdt > 0);
});
test("forced end-of-data close is flagged and funding outside the history is counted unknown, not zero", () => {
  const r = simulate({ analyst: "balanced", snaps: { BTCUSDT: [snap(T0 + BAR, 60000)] }, m1: { BTCUSDT: flat(T0, 30, 60000) }, funding: { BTCUSDT: [] }, instruments: inst, policy: once(5000, 5000, 400) });
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].forced, true); assert.equal(r.trades[0].reason, "end_of_data"); assert.equal(r.trades[0].funding_unknown, true);
});
test("account suspension is a mode: a 5% drawdown halts new entries when ON and not when OFF", () => {
  const losing = (cfg) => { const snaps = []; for (let i = 1; i <= 60; i++) snaps.push(snap(T0 + i * BAR, 60000));
    // every trade stops out: price drops 1% right after each entry
    const m1 = flat(T0, 61 * 15, 60000).map((c, k) => (k % 15 === 5 ? { ...c, l: 59000, c: 59000 } : c));
    return simulate({ analyst: "risk_taker", snaps: { BTCUSDT: snaps }, m1: { BTCUSDT: m1 }, funding: {}, instruments: inst, config: cfg,
      policy: (a, s, ctx) => (ctx.position_open ? { analyst: a, intent: "WAIT", code: "POSITION_OPEN" } : { analyst: a, intent: "OPEN_LONG", code: "SETUP", setup: { stop: s.ask - 300, target: s.ask + 3000, time_exit_ts: s.bar_close_ts + 4 * BAR, trigger: "T" } }) }); };
  const on = losing(risk.RISK_DEFAULTS), off = losing({ ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 });
  assert.ok(on.counts["risk_reject:DRAWDOWN_SUSPENDED"] > 0 || on.counts["risk_reject:DAILY_LOSS_SUSPENDED"] > 0, JSON.stringify(on.counts));
  assert.ok(off.trades.length > on.trades.length, `${off.trades.length} vs ${on.trades.length}`);
  assert.equal(off.counts["risk_reject:DRAWDOWN_SUSPENDED"], undefined);
});
test("gate blocks NEW entries only and is counted", () => {
  const r = run(flat(T0, 60, 60000), once(5000, 5000), { gate: () => ({ block: true, reason: "STRESS" }) });
  assert.equal(r.trades.length, 0); assert.equal(r.counts.blocked_by_gate, 1);
});

test("metrics: summarize is exact on a known set and bootstrap is deterministic", () => {
  const T = [{ net: 10, R: 1, fees: 1, funding: 0, closed_ts: T0, opened_ts: T0 - 1, bars_held: 1, notional: 100, ambiguous: false, funding_unknown: false, slippage_cost: 0.1 },
    { net: -5, R: -0.5, fees: 1, funding: 0, closed_ts: T0 + 86400000, opened_ts: T0, bars_held: 1, notional: 100, ambiguous: false, funding_unknown: false, slippage_cost: 0.1 }];
  const s = M.summarize(T, { days: 2 }); assert.equal(s.trades, 2); assert.equal(s.net_usdt, 5); assert.equal(s.win_rate, 0.5); assert.ok(Math.abs(s.profit_factor - 2) < 1e-9);
  const a = M.dayBootstrap(T, { from: T0, to: T0 + 2 * 86400000, B: 200, seed: 7 }), b = M.dayBootstrap(T, { from: T0, to: T0 + 2 * 86400000, B: 200, seed: 7 }); assert.deepEqual(a, b);
  assert.deepEqual(M.summarize([], { days: 2 }).trades, 0);
});
test("metrics: max drawdown is peak-to-trough on the equity curve", () => {
  const d = M.maxDrawdown([{ ts: 1, equity: 100 }, { ts: 2, equity: 120 }, { ts: 3, equity: 90 }, { ts: 4, equity: 130 }]); assert.ok(Math.abs(d.max_drawdown_pct - (-25)) < 1e-9);
});
test("hist: only complete 15-minute buckets are produced from 1m rows", () => {
  const rows = flat(T0, 15, 10).concat(flat(T0 + BAR, 14, 11));            // second bucket is missing one minute
  const a = H.aggregate15(rows); assert.equal(a.length, 1); assert.equal(a[0].open_ts, T0);
});
test("baselines: random policy is reproducible for a seed and respects open positions", () => {
  const p1 = B.randomPolicy(0.5, 3), p2 = B.randomPolicy(0.5, 3), s = snap(T0 + BAR, 60000);
  const A = [], C = []; for (let i = 0; i < 20; i++) { A.push(p1("balanced", { ...s, bar_close_ts: s.bar_close_ts + i * BAR }, {}).intent); C.push(p2("balanced", { ...s, bar_close_ts: s.bar_close_ts + i * BAR }, {}).intent); }
  assert.deepEqual(A, C); assert.equal(p1("balanced", s, { position_open: true }).code, "POSITION_OPEN");
});
test("account identity: end cash equals start equity plus the sum of trade nets (entry fee leaves cash exactly once)", () => {
  for (const m1 of [flat(T0, 60, 60000, { 20: { h: 60300 } }), flat(T0, 60, 60000, { 20: { l: 59700 } })]) {
    const r = run(m1, once(200, 300)); const sum = r.trades.reduce((a, t) => a + t.net, 0);
    assert.ok(Math.abs(r.end_cash - (r.start_equity + sum)) < 1e-9, `${r.end_cash} vs ${r.start_equity + sum}`);
  }
});
test("fixed sizing: the risk budget stays constant after losses (no depletion artefact); compounding shrinks it", () => {
  const snaps = []; for (let i = 1; i <= 40; i++) snaps.push(snap(T0 + i * BAR, 60000));
  const m1 = flat(T0, 41 * 15, 60000).map((c, k) => (k % 15 === 5 ? { ...c, l: 59000, c: 59000 } : c));
  const pol = (a, s, ctx) => (ctx.position_open ? { analyst: a, intent: "WAIT", code: "POSITION_OPEN" } : { analyst: a, intent: "OPEN_LONG", code: "SETUP", setup: { stop: s.ask - 300, target: s.ask + 3000, time_exit_ts: s.bar_close_ts + 4 * BAR, trigger: "T" } });
  const free = { ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 }, base = { analyst: "risk_taker", snaps: { BTCUSDT: snaps }, m1: { BTCUSDT: m1 }, funding: {}, instruments: inst, config: free, policy: pol };
  const c = simulate(base), f = simulate({ ...base, fixedSizing: true });
  assert.ok(c.trades.length > 5 && f.trades.length === c.trades.length); const risks = t => t.map(x => x.risk_usdt);
  assert.ok(risks(f.trades).every(r => Math.abs(r - risks(f.trades)[0]) < 1e-9), "fixed: constant risk budget"); assert.ok(risks(c.trades)[c.trades.length - 1] < risks(c.trades)[0], "compounding: risk shrinks with equity");
});
test("fixed sizing: the account going NEGATIVE does not trip the daily-loss or drawdown gates (a sign flip in the day-start equity once blocked every later trade)", () => {
  const n = 40, DAYMS = 86400000, snaps = []; for (let i = 1; i <= n; i++) snaps.push(snap(T0 + i * DAYMS, 60000));          // one decision per UTC day, so the day-start equity is re-read every day
  const m1 = flat(T0, (n + 2) * 1440, 60000).map((c, k) => (k % 1440 === 3 ? { ...c, o: 54000, h: 54000, l: 53900, c: 54000 } : c));   // gap far through the stop each day: losses of many R
  const pol = (a, s, ctx) => (ctx.position_open ? { analyst: a, intent: "WAIT", code: "POSITION_OPEN" } : { analyst: a, intent: "OPEN_LONG", code: "SETUP", setup: { stop: s.ask - 300, target: s.ask + 3000, time_exit_ts: s.bar_close_ts + 40 * BAR, trigger: "T" } });
  const base = { analyst: "risk_taker", snaps: { BTCUSDT: snaps }, m1: { BTCUSDT: m1 }, funding: {}, instruments: inst, config: { ...risk.RISK_DEFAULTS, dailyLossFrac: 10, maxDrawdownFrac: 10 }, policy: pol };
  const f = simulate({ ...base, fixedSizing: true }); assert.ok(f.end_cash < 0, "the account really went negative: " + f.end_cash);
  assert.ok(f.trades.length >= 35, `trades kept flowing: ${f.trades.length}`); assert.equal(f.counts["risk_reject:DAILY_LOSS_SUSPENDED"], undefined); assert.equal(f.counts["risk_reject:DRAWDOWN_SUSPENDED"], undefined);
});
