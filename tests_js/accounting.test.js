"use strict";
/* Hand-calculated accounting fixtures (valuation-v1). Every expected number below was worked out by hand and is shown
 * in the comment next to it. The fee rate used here (0.1%) is a HYPOTHETICAL TEST RATE, not an exchange fee. */
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../server/accounting");

const LIN = { linear: 1, settle: "USDT", multiplier: "1" };
const FEE = 0.001;                                   // hypothetical test fee rate
const near = (a, b, msg) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg || ""} got ${a}, expected ${b}`);
const entry = (id, qty, price, ts = 1) => ({ fill_id: id, ts, kind: "ENTRY", qty, price, fee: Number(qty) * price * FEE });
const exit = (id, qty, price, ts = 2) => ({ fill_id: id, ts, kind: "EXIT", qty, price, fee: Number(qty) * price * FEE });

test("long 0.01 BTC from 100,000: mark 101,000 = +10 gross; the same short = -10", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN), S = A.positionFromFills(-1, [entry("a", "0.01", 100000)], LIN);
  near(A.markUnrealized(L, 101000), 10);             // 1 * 0.01 * (101000 - 100000)
  near(A.markUnrealized(S, 101000), -10);            // -1 * 0.01 * 1000
  assert.equal(L.state, "OPEN"); near(L.entry_fees, 1.0);   // 0.01 * 100000 * 0.001
});

test("close-now estimate is distinct from the mark value: bids at 100,980 give +9.80 gross, +8.7902 after the estimated exit fee", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN);
  const ce = A.closeEstimate(L, { bids: [["100980", "1"]], asks: [["100990", "1"]] }, { feeRate: FEE });
  assert.equal(ce.status, "OK"); near(ce.x, 100980);
  near(ce.exit_fee_est, 1.0098);                     // 0.01 * 100980 * 0.001
  near(ce.remaining_close_contribution, 8.7902);     // 9.80 - 1.0098
  near(A.lifecycleIfClosedNow(L, ce, 0), 7.7902);    // 8.7902 - entry fee 1.0
  near(A.lifecycleIfClosedNow(L, ce, -0.5), 7.2902); // funding paid 0.5
  near(A.lifecycleIfClosedNow(L, ce, 0.3), 8.0902);  // funding received 0.3
  assert.notEqual(A.markUnrealized(L, 101000), ce.remaining_close_contribution);
});

test("depth walk: the estimate uses as many levels as the quantity needs and never assumes unlimited size at the best bid", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN);
  const two = A.closeEstimate(L, { bids: [["100980", "0.004"], ["100970", "0.01"]] }, { feeRate: FEE });
  near(two.x, 100974);                               // (0.004*100980 + 0.006*100970) / 0.01
  const thin = A.closeEstimate(L, { bids: [["100980", "0.006"]] }, { feeRate: FEE });
  assert.equal(thin.status, "PARTIAL_LIQUIDITY"); near(thin.coverage, 0.6);
  assert.equal(thin.remaining_close_contribution, null); assert.equal(A.lifecycleIfClosedNow(L, thin, 0), null);
  assert.equal(A.closeEstimate(L, { bids: [] }, { feeRate: FEE }).status, "UNAVAILABLE");
  const S = A.positionFromFills(-1, [entry("a", "0.01", 100000)], LIN);
  near(A.closeEstimate(S, { bids: [["1", "1"]], asks: [["99900", "1"]] }, { feeRate: FEE }).remaining_close_contribution, 1 - 0.999);  // short closes on the ASK: 0.01*100 - 0.999
  near(A.closeEstimate(L, { bids: [["100980", "1"]] }, { feeRate: FEE, extraSlipFrac: 0.001 }).x, 100980 * 0.999);                     // explicit extra slippage only when asked
});

test("partial exit: realised and remaining parts reconcile; entry fees split pro rata and still sum to what was paid", () => {
  const P = A.positionFromFills(1, [entry("a", "0.03", 100000), exit("b", "0.01", 100500)], LIN);
  assert.equal(P.state, "PARTIAL"); near(P.remaining_qty, 0.02); near(P.avg_entry, 100000);
  near(P.realized_gross, 5);                         // 0.01 * 500
  near(P.entry_fees, 3.0); near(P.entry_fees_closed, 1.0); near(P.entry_fees_open, 2.0); near(P.entry_fees_closed + P.entry_fees_open, P.entry_fees);
  near(P.exit_fees, 1.005);                          // 0.01 * 100500 * 0.001
  near(A.markUnrealized(P, 101000), 20);             // 0.02 * 1000
  const ce = A.closeEstimate(P, { bids: [["100980", "5"]] }, { feeRate: FEE });
  near(ce.remaining_close_contribution, 17.5804);    // 0.02*980 = 19.6 ; fee 0.02*100980*0.001 = 2.0196
  near(A.lifecycleIfClosedNow(P, ce, 0), 18.5754);   // 5 + 17.5804 - 3.0 - 1.005
  const C = A.positionFromFills(1, [entry("a", "0.03", 100000), exit("b", "0.01", 100500), exit("c", "0.02", 100980, 3)], LIN);
  assert.equal(C.state, "CLOSED"); near(C.realized_gross, 24.6);   // 5 + 19.6
  near(C.realized_gross - C.entry_fees - C.exit_fees, 18.5754, "closed result equals the earlier close-now estimate at the same price");
  assert.throws(() => A.positionFromFills(1, [entry("a", "0.01", 100000), exit("b", "0.02", 100500)], LIN), /larger than the remaining/);
});

test("multiple entry fills use quantity-weighted average cost", () => {
  const P = A.positionFromFills(1, [entry("a", "0.01", 100000), entry("b", "0.03", 100400, 2)], LIN);
  near(P.avg_entry, 100300);                         // (1000 + 3012) / 0.04
  near(A.markUnrealized(P, 100500), 8);              // 0.04 * 200
});

test("contract multipliers convert to base quantity; non-linear or non-USDT contracts are rejected, not valued", () => {
  const P = A.positionFromFills(1, [{ fill_id: "a", ts: 1, kind: "ENTRY", qty: "10", price: 100000, fee: 1 }], { linear: 1, settle: "USDT", multiplier: "0.001" });
  near(P.remaining_qty, 0.01); near(A.markUnrealized(P, 101000), 10);
  assert.throws(() => A.positionFromFills(1, [entry("a", "1", 100000)], { linear: 0, settle: "BTC", multiplier: "1" }), /UNSUPPORTED_CONTRACT/);
  assert.throws(() => A.positionFromFills(1, [entry("a", "1", 100000)], { linear: 1, settle: "USDC", multiplier: "1" }), /UNSUPPORTED_CONTRACT/);
  assert.throws(() => A.positionFromFills(1, [entry("a", "1", 100000)], { linear: 1, settle: "USDT", multiplier: "0" }), /multiplier/);
});

test("zero quantity and invalid prices never produce a number that looks like P&L", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN);
  for (const bad of [0, -5, NaN, Infinity, null, undefined, "101000"]) assert.equal(A.markUnrealized(L, bad), null);
  assert.throws(() => A.positionFromFills(1, [{ fill_id: "z", ts: 1, kind: "ENTRY", qty: "0", price: 100000, fee: 0 }], LIN), /zero-quantity/);
  assert.throws(() => A.positionFromFills(1, [{ fill_id: "z", ts: 1, kind: "ENTRY", qty: "0.01", price: 0, fee: 0 }], LIN), /invalid fill/);
  const flat = A.positionFromFills(1, [entry("a", "0.01", 100000), exit("b", "0.01", 100100)], LIN);
  near(A.markUnrealized(flat, 105000), 0); assert.equal(A.closeEstimate(flat, { bids: [] }, { feeRate: FEE }).status, "FLAT");
  assert.equal(A.positionFromFills(1, [], LIN).state, "EMPTY");
});

test("repeated fill events are applied once (idempotent projection)", () => {
  const once = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN), twice = A.positionFromFills(1, [entry("a", "0.01", 100000), entry("a", "0.01", 100000)], LIN);
  assert.deepEqual({ ...twice, remaining_units: String(twice.remaining_units) }, { ...once, remaining_units: String(once.remaining_units) });
});

test("funding: a long pays positive funding, a short receives it; the sign flips with the rate", () => {
  near(A.fundingCashflow(1, 0.01, 0.0005, 100000), -0.5);   // -1 * 0.0005 * 0.01 * 100000
  near(A.fundingCashflow(-1, 0.01, 0.0005, 100000), 0.5);
  near(A.fundingCashflow(1, 0.01, -0.0003, 100000), 0.3);
  assert.equal(A.fundingCashflow(1, 0.01, 0.0005, NaN), null);
});

test("stale mark with a fresh book, and a fresh mark with a stale book, are reported separately", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN), now = 1000000;
  const book = { state: "VALID", ts: now - 500, bids: [["100980", "1"]], asks: [["100990", "1"]] };
  const a = A.valuePosition({ pos: L, mark: { price: 101000, ts: now - 60000 }, book, now, feeRate: FEE, leverage: 2 });
  assert.equal(a.mark.status, "STALE"); assert.equal(a.u_mark_is_stale, true); near(a.u_mark, 10); assert.equal(a.close_now.status, "OK"); assert.equal(a.close_now.is_stale, false);
  const b = A.valuePosition({ pos: L, mark: { price: 101000, ts: now - 200 }, book: { ...book, ts: now - 60000 }, now, feeRate: FEE, leverage: 2 });
  assert.equal(b.mark.status, "OK"); assert.equal(b.close_now.is_stale, true); assert.ok(b.quality.includes("book_stale"));
  const c = A.valuePosition({ pos: L, mark: null, book: { ...book, state: "INVALID" }, now, feeRate: FEE, leverage: 2 });
  assert.equal(c.u_mark, null); assert.equal(c.close_now.status, "UNAVAILABLE"); assert.equal(c.lifecycle_if_closed_now, null);
});

test("percentages name their denominators; leverage changes the margin denominator, never the P&L", () => {
  const L = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN);
  const p2 = A.percentages(L, 10, 7.7902, 2), p5 = A.percentages(L, 10, 7.7902, 5);
  near(p2.gross_unrealized_pct_of_entry_notional, 1.0);         // 10 / 1000
  near(p2.gross_unrealized_pct_of_initial_margin, 2.0);         // 10 / (1000 / 2)
  near(p5.gross_unrealized_pct_of_initial_margin, 5.0);         // same 10 USDT, smaller margin
  near(p2.net_lifecycle_pct_of_initial_margin_of_full_entry, 1.55804);   // 7.7902 / 500
  assert.equal(A.percentages(L, null, null, 2).gross_unrealized_pct_of_entry_notional, null);
  assert.equal(A.percentages(L, 10, 1, 0).gross_unrealized_pct_of_initial_margin, null, "N/A without a margin model");
});

test("account: cash, mark equity, reserved margin and available balance reconcile; booked fees are not subtracted twice", () => {
  const open = A.positionFromFills(1, [entry("a", "0.01", 100000)], LIN);
  const closed = A.positionFromFills(1, [entry("b", "0.01", 100000), exit("c", "0.01", 100980)], LIN);
  const v = A.accountView({ start: 1000, leverage: 2, positions: [{ pos: open, funding: -0.5, u_mark: 10 }, { pos: closed, funding: 0, u_mark: null }] });
  near(v.realized_gross, 9.8); near(v.fees_booked, 1 + 1 + 1.0098); near(v.funding_settled, -0.5);
  near(v.cash_balance, 1000 + 9.8 - 3.0098 - 0.5);              // 1006.2902
  near(v.mark_equity, 1016.2902); near(v.reserved_margin, 500); // 0.01 * 100000 / 2
  near(v.available_balance, 506.2902);
  const ce = A.closeEstimate(open, { bids: [["100980", "1"]] }, { feeRate: FEE });
  near(v.cash_balance + ce.remaining_close_contribution, 1015.0804, "close-out equity = cash + remaining contribution (entry fee already inside cash)");
  const unk = A.accountView({ start: 1000, leverage: 2, positions: [{ pos: open, funding: 0, u_mark: null }] });
  assert.equal(unk.mark_equity, null, "no mark -> equity is unavailable, not silently equal to cash"); assert.equal(unk.positions_without_mark, 1);
});
