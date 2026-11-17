"use strict";
/* live-metrics-v1: hand-calculated fixtures (every expected number below is computed by hand in the comment next to it) and engine-path reconciliation. */
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../server/accounting");
const { Store } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const { Monitor } = require("../server/monitor");
const { Health } = require("../server/health");
const { buildInfo } = require("../server/runtime");
const { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const near = (a, b, m, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${m || ""} got ${a}, expected ${b}`);
const BTC = { linear: 1, settle: "USDT", multiplier: "1", base: "BTC" };
const fill = (id, kind, qty, price, fee, ts) => ({ fill_id: id, kind, qty, price, fee, ts });
const val = (pos, markPx, bookPx, { age = 500, bookAge = 500, settled = 0, size = 1000 } = {}) => {
  const book = bookPx === null ? null : { state: "VALID", ts: 1000 - bookAge, bids: [[bookPx, size]], asks: [[bookPx, size]] };
  return A.valuePosition({ pos, mark: markPx === null ? null : { price: markPx, ts: 1000 - age }, book, now: 1000, feeRate: 0.0006, leverage: 5, settledFunding: settled });
};
const metrics = (pos, v, lev, extra = {}) => A.liveMetrics({ pos, valuation: v, leverage: lev, ...extra });

test("the brief's fixture: 0.01 BTC, entry 50,000, mark 51,000 -> LONG +10, SHORT -10; margin 100 gives +/-10%, margin 50 gives +/-20% and the P&L does not move", () => {
  for (const [side, sign] of [[1, 1], [-1, -1]]) {
    const pos = A.positionFromFills(side, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC), v = val(pos, 51000, 51000);
    const m5 = metrics(pos, v, 5), m10 = metrics(pos, v, 10);                         // entry notional 500 USDT: /5 = 100 margin, /10 = 50 margin
    near(m5.gross_unrealized.value, sign * 10, "gross P&L = s*q*(M-E) = +/-0.01*1000");
    near(m10.gross_unrealized.value, sign * 10, "changing only the margin must not change the P&L");
    near(m5.margin.initial, 100); near(m10.margin.initial, 50);
    const r5 = m5.roi.find(x => x.primary), r10 = m10.roi.find(x => x.primary);
    near(r5.value, sign * 10, "10 / 100 = 10%"); near(r10.value, sign * 20, "10 / 50 = 20%");
    assert.equal(r5.denominator_usdt, 100); assert.equal(r10.denominator_usdt, 50); assert.match(r5.denominator, /initial margin/);
    assert.equal(m5.gross_unrealized.class, sign > 0 ? "GAIN" : "LOSS");
    near(m5.notional.at_mark, 510, "0.01 * 51,000"); near(m5.margin.notional_at_mark_per_allocated_margin, 5.1, "mark notional / allocated margin = 510/100");
    near(m5.notional.entry_full, 500);
  }
});

test("exact break-even and gain outweighed by costs: classes and signs", () => {
  let pos = A.positionFromFills(1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC);
  let m = metrics(pos, val(pos, 50000, 50000), 5);
  assert.equal(m.gross_unrealized.value, 0); assert.equal(m.gross_unrealized.class, "FLAT"); assert.equal(m.roi[0].value, 0, "break-even is 0%, not unavailable");
  assert.ok(m.net_if_closed.whole_trade.net < 0, "costs make a gross-flat trade a net loss");
  // mark 50,002: gross = 0.01*2 = +0.02 (GAIN). Costs: entry fee 0.30 + exit fee est 0.01*50,002*0.0006 = 0.300012  => whole-trade net = 0.02 - 0.30 - 0.300012 = -0.580012
  m = metrics(pos, val(pos, 50002, 50002), 5);
  near(m.gross_unrealized.value, 0.02); assert.equal(m.gross_unrealized.class, "GAIN");
  near(m.net_if_closed.whole_trade.net, 0.02 - 0.3 - 0.300012, "whole-trade net by hand"); assert.equal(m.net_if_closed.whole_trade.class, "LOSS");
  // display tolerance: +0.004 USDT is FLAT, +0.005 is a GAIN
  assert.equal(A.signClass(0.004), "FLAT"); assert.equal(A.signClass(0.005), "GAIN"); assert.equal(A.signClass(-0.005), "LOSS"); assert.equal(A.signClass(null), "UNAVAILABLE");
});

test("funding: payments and receipts enter the whole-trade net once; the unsettled estimate is separate and never in a net figure", () => {
  const long = A.positionFromFills(1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC), short = A.positionFromFills(-1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC);
  // rate +0.0001, mark 50,000, q 0.01: cashflow = -s*rate*q*mark = -s*0.05 USDT (a long PAYS)
  const vL = val(long, 50000, 50000, { settled: -0.05 }), vS = val(short, 50000, 50000, { settled: +0.05 });
  const mL = metrics(long, vL, 5, { funding: { rate: 0.0001, next_settlement_ts: 5 } }), mS = metrics(short, vS, 5, { funding: { rate: 0.0001, next_settlement_ts: 5 } });
  near(mL.unsettled_funding_estimate.usdt, -0.05); near(mS.unsettled_funding_estimate.usdt, +0.05);
  assert.equal(mL.unsettled_funding_estimate.included_in_any_net_figure, false);
  // whole net long = 0 gross - 0.3 entry fee - 0.3 exit fee est (0.01*50000*0.0006) + settled (-0.05) = -0.65 ; short: +0.05 => -0.55
  near(mL.net_if_closed.whole_trade.net, -0.65); near(mS.net_if_closed.whole_trade.net, -0.55);
  const neg = metrics(long, vL, 5, { funding: { rate: -0.0002, next_settlement_ts: 5 } }); near(neg.unsettled_funding_estimate.usdt, +0.1, "a negative rate: the long RECEIVES");
  assert.equal(metrics(long, vL, 5).unsettled_funding_estimate.usdt, null, "no rate => no estimate, not 0");
});

test("quantity and contract conversion happen exactly once", () => {
  const ins = { linear: 1, settle: "USDT", multiplier: "0.01", base: "BTC" };              // 1 contract = 0.01 BTC
  const pos = A.positionFromFills(1, [fill("e", "ENTRY", "3", 50000, 0.9, 1)], ins);       // 3 contracts = 0.03 BTC
  near(pos.remaining_qty, 0.03, "base quantity");
  const m = metrics(pos, val(pos, 51000, 51000), 5);
  near(m.quantity_base, 0.03); near(m.notional.entry_full, 1500, "0.03 * 50,000, NOT 3 * 0.01 * 0.01"); near(m.gross_unrealized.value, 30, "0.03 * 1000");
  assert.throws(() => A.positionFromFills(1, [fill("e", "ENTRY", "1", 50000, 0, 1)], { linear: 0, settle: "USDT", multiplier: "1" }), /UNSUPPORTED_CONTRACT/);
});

test("partial exit: lot accounting, margins from the right quantities, and the identity whole-trade = remaining-leg + realized part", () => {
  // enter 0.04 @ 50,000 (fee 1.2); exit 0.01 @ 51,000 (fee 0.306): realized gross = 0.01*1000 = 10; remaining 0.03; entry fee closed share 1.2*0.25 = 0.3, open 0.9
  const pos = A.positionFromFills(1, [fill("e", "ENTRY", "0.04", 50000, 1.2, 1), fill("x", "EXIT", "0.01", 51000, 0.306, 2)], BTC);
  near(pos.realized_gross, 10); near(pos.remaining_qty, 0.03); near(pos.entry_fees_closed, 0.3); near(pos.entry_fees_open, 0.9);
  const v = val(pos, 52000, 52000);                                                         // mark 52,000: u = 0.03*2000 = 60
  const m = metrics(pos, v, 5);
  near(m.gross_unrealized.value, 60);
  near(m.margin.initial, 2000 / 5, "initial margin uses the FULL entry notional 0.04*50,000 = 2,000 -> 400"); near(m.margin.allocated_now, 1500 / 5, "current margin uses the remaining 0.03*50,000 = 1,500 -> 300");
  near(m.roi.find(x => x.key === "gross_return_on_initial_margin").value, 60 / 400 * 100); near(m.roi.find(x => x.key === "gross_return_on_current_margin").value, 60 / 300 * 100);
  // remaining leg: gross close 0.03*2000 = 60; exit fee est 0.03*52000*0.0006 = 0.936; allocated entry fee 0.9 -> net 58.164
  near(m.net_if_closed.remaining_leg.net, 60 - 0.936 - 0.9);
  // whole trade: 10 + 60 - 1.2 - 0.306 - 0.936 = 67.558
  near(m.net_if_closed.whole_trade.net, 10 + 60 - 1.2 - 0.306 - 0.936);
  near(m.net_if_closed.whole_trade.identity_residual, 0, "whole-trade = remaining-leg net + realized part (10 - 0.3 - 0.306)");
  near(m.net_if_closed.whole_trade.realized_part, 10 - 0.3 - 0.306);
});

test("missing or invalid denominators and inputs give unavailable values WITH reasons, never 0% or infinity", () => {
  const pos = A.positionFromFills(1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC);
  let m = metrics(pos, val(pos, 51000, 51000), null);                                       // no margin setting
  assert.equal(m.margin.initial, null); const r = m.roi[0]; assert.equal(r.value, null); assert.equal(r.reason, "DENOMINATOR_UNAVAILABLE");
  m = metrics(pos, val(pos, null, 51000), 5);                                               // no mark
  assert.equal(m.gross_unrealized.value, null); assert.equal(m.gross_unrealized.class, "UNAVAILABLE"); assert.equal(m.roi[0].reason, "MARK_UNAVAILABLE");
  assert.equal(m.prices.mark_status, "UNAVAILABLE");
  m = metrics(pos, val(pos, 51000, null), 5);                                               // mark fine, no book: mark P&L stays, executable estimate does not
  near(m.gross_unrealized.value, 10); assert.equal(m.net_if_closed.whole_trade, null); assert.equal(m.net_if_closed.remaining_leg, null); assert.equal(m.net_if_closed.status, "UNAVAILABLE");
  assert.equal(m.roi.find(x => x.key === "net_if_closed_on_initial_margin").reason, "CLOSE_ESTIMATE_UNAVAILABLE");
  m = metrics(pos, val(pos, 51000, 51000, { size: 0.001 }), 5);                             // book too thin for the whole quantity
  assert.equal(m.net_if_closed.status, "PARTIAL_LIQUIDITY"); assert.equal(m.net_if_closed.whole_trade, null);
  assert.equal(m.risk_budget.gross_unrealized_per_risk_budget.reason, "DENOMINATOR_UNAVAILABLE", "no recorded risk budget => unavailable");
  m = metrics(pos, val(pos, 51000, 51000), 5, { recorded: { margin: 100, notional: 500, risk_usdt: 2 } });
  near(m.risk_budget.gross_unrealized_per_risk_budget.value, 10 / 2 * 100, "P&L / recorded risk budget (500%: shown as a percentage of the budget)");
  assert.equal(m.margin.recorded_at_entry.basis, "ledger risk record, computed on the pre-slippage reference price");
});

test("freshness: a fresh mark with a stale book keeps mark P&L and marks only the executable estimate stale", () => {
  const pos = A.positionFromFills(1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC);
  const v = val(pos, 51000, 51000, { age: 500, bookAge: 60000 }), m = metrics(pos, v, 5);
  assert.equal(m.prices.mark_status, "OK"); assert.equal(m.prices.book_status, "STALE"); near(m.gross_unrealized.value, 10);
  assert.equal(m.freshness.mark_fresh, true); assert.equal(m.freshness.book_fresh, false);
  const old = metrics(pos, val(pos, 51000, 51000, { age: 60000 }), 5);
  assert.equal(old.prices.mark_status, "STALE"); near(old.gross_unrealized.value, 10, "the last valid value is retained and labelled stale, never zeroed");
});

test("account extras: closeout equity = cash + sum(remaining close contribution); unavailable if any leg lacks an estimate; exposure and pricing completeness", () => {
  const p1 = A.positionFromFills(1, [fill("a", "ENTRY", "0.01", 50000, 0.3, 1)], BTC), p2 = A.positionFromFills(-1, [fill("b", "ENTRY", "0.1", 3000, 0.18, 1)], { ...BTC, base: "ETH" });
  const v1 = val(p1, 51000, 51000), v2 = val(p2, 2990, 2990);
  const av = A.accountView({ start: 1000, positions: [{ pos: p1, funding: 0, u_mark: v1.u_mark }, { pos: p2, funding: 0, u_mark: v2.u_mark }], leverage: 2 });
  near(av.cash_balance, 1000 - 0.3 - 0.18);
  const ex = A.accountExtras({ av, items: [{ pos: p1, v: v1 }, { pos: p2, v: v2 }], start: 1000 });
  // contributions: p1 = 0.01*(51000-50000) - 0.01*51000*0.0006 = 10 - 0.306 = 9.694 ; p2 (short) = 0.1*-(2990-3000) - 0.1*2990*0.0006 = 1 - 0.1794 = 0.8206
  near(ex.closeout.equity_estimate, 1000 - 0.48 + 9.694 + 0.8206, "closeout equity by hand"); near(ex.closeout.equity_estimate - av.mark_equity, -(0.306 + 0.1794), "closeout - mark equity = minus the unbooked exit fees only (no double counting)");
  near(ex.exposure.gross_notional_at_mark, 0.01 * 51000 + 0.1 * 2990); near(ex.exposure.net_signed_notional_at_mark, 510 - 299);
  assert.equal(ex.pricing.completeness, "COMPLETE");
  const vNoBook = val(p2, 2990, null), ex2 = A.accountExtras({ av, items: [{ pos: p1, v: v1 }, { pos: p2, v: vNoBook }], start: 1000 });
  assert.equal(ex2.closeout.equity_estimate, null); assert.match(ex2.closeout.reason, /no OK executable-close estimate/); assert.equal(ex2.pricing.completeness, "PARTIAL");
  near(ex.account_return.value_pct, (av.mark_equity / 1000 - 1) * 100); assert.match(ex.account_return.definition, /never averaged/);
  const flat = A.accountExtras({ av: A.accountView({ start: 1000, positions: [], leverage: 2 }), items: [], start: 1000 });
  assert.equal(flat.pricing.completeness, "NO_OPEN_POSITIONS"); near(flat.closeout.equity_estimate, 1000);
});

test("margin change arithmetic (unsupported by the engine, tested as arithmetic): only margin denominators move, never price P&L", () => {
  const pos = A.positionFromFills(-1, [fill("e", "ENTRY", "0.01", 50000, 0.3, 1)], BTC), v = val(pos, 50500, 50500);
  const a = metrics(pos, v, 2), b = metrics(pos, v, 20);
  near(a.gross_unrealized.value, b.gross_unrealized.value); near(a.net_if_closed.whole_trade.net, b.net_if_closed.whole_trade.net);
  near(b.roi[0].value / a.roi[0].value, 10, "ten times the leverage setting = one tenth of the margin = ten times the ROI on margin, same dollars");
});

/* ---------------------------------------------------------------- engine-path reconciliation */
const ID = "bitget:perp:BTCUSDT", CLOSE = Date.UTC(2026, 10, 16, 9);
function rig() {
  let t = CLOSE + 3000; const now = () => t, store = new Store(":memory:", { now }), ledger = new Ledger(store, { now, codeRev: "test" });
  store.upsertInstrument(fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", t));
  const book = { state: "VALID", recvTs: t, top: () => ({ bids: [["64900", "100"]], asks: [["64900.1", "100"]] }) };
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: { [ID]: { last: "64900", bid: "64899.9", ask: "64900", mark: "64901", index_px: "64900", exch_ts: t, recv_ts: t, funding_rate: "0.0001", next_funding_ts: CLOSE + 4 * 3600000 } }, books: { [ID]: book } };
  const health = new Health({ now });
  const snap = { instrument_id: ID, bar_close_ts: CLOSE, decision_ts: CLOSE + 3000, hash: "h1", missing: [], health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
    trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.02, bid: 64899.9, ask: 64900, depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, data_cutoff_ts: CLOSE + 2000,
    triggers: [{ code: "RETEST_UP", name: "RETEST_UP", dir: 1, stop: 64600, level: null }] };
  const engine = new PaperEngine({ store, ledger, collector, health, now, buildSnapshot: () => snap }); engine.feedHealthy = () => true;
  const runtime = { build: buildInfo(), instance_id: engine.instanceId, started_at: t, database: store.identity("FORWARD"), engine_error: null };
  return { store, ledger, engine, monitor: new Monitor({ store, collector, health, getEngine: () => engine, runtime, now }), book, collector, now };
}

test("reconciliation through the ENGINE's own close path: the pre-close whole-trade estimate equals the booked result at the same price and fee; closeout equity equals the cash afterwards", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const X = 65200;                                                                              // the price we will close at; the book is deep at exactly X so the depth walk returns X
  r.book.top = () => ({ bids: [[String(X), "1000"]], asks: [[String(X), "1000"]] });
  const before = r.monitor.accounts().accounts, est = {};
  for (const p of r.store.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN'").all()) {
    const view = r.monitor.positionView(p); est[p.analyst] = view.live.net_if_closed.whole_trade.net;
    near(view.live.net_if_closed.whole_trade.identity_residual, 0, "identity on a real engine position");
    near(view.valuation.lifecycle_if_closed_now, est[p.analyst], "key valuation-v1 value equals the live-metrics whole-trade net");
    assert.ok(view.live.margin.recorded_at_entry && view.live.margin.recorded_at_entry.risk_usdt > 0, "recorded sizing found in the ledger risk status");
    near(view.live.margin.initial, p.qty * view.entry_fill_price / 2, "margin = fill notional / 2x setting");
  }
  const estEq = Object.fromEntries(before.map(a => [a.analyst, a.closeout.equity_estimate]));
  for (const p of r.store.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN'").all()) r.engine.close(p, X, r.now(), "reconcile-test", 0);
  for (const p of r.store.db.prepare("SELECT * FROM paper_positions WHERE state='CLOSED'").all()) near(p.pnl, est[p.analyst], `booked net result of ${p.analyst} vs the pre-close estimate`, 1e-9);
  const after = r.monitor.accounts().accounts;
  for (const a of after) { near(a.cash_balance, estEq[a.analyst], `cash after closing = closeout equity estimated before (${a.analyst})`, 1e-9); assert.equal(a.cash_reconciles, true); }
  assert.equal(r.ledger.verify().ok, true);
});
