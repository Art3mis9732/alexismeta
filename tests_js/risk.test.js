"use strict";
/* Risk gate + sizing tests. Sizing must reproduce bgbot/sizing.py on 864 generated cases. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { sizePosition, evaluate, stepsToDec, RISK_DEFAULTS } = require("../server/risk");
const CASES = require("./fixtures/sizing_cases.json").cases;

const CODE_OF = r => r === "ok" ? "OK" : r.startsWith("portfolio open-risk") ? "OPEN_RISK_LIMIT" : r.startsWith("below exchange minimum") ? "MIN_SIZE_EXCEEDS_BUDGET"
  : r.startsWith("notional") ? "MIN_NOTIONAL" : r.startsWith("liquidation") ? "LIQ_TOO_CLOSE" : r === "invalid inputs" ? "INVALID_INPUT" : "?";

test("sizing: JS port reproduces bgbot/sizing.py on every generated case (qty, decision, risk, liquidation)", () => {
  let n = 0;
  for (const c of CASES) {
    const js = sizePosition(c.input), py = c.output;
    assert.equal(js.code, CODE_OF(py.reason), `${c.symbol} ${JSON.stringify(c.input)}: ${py.reason}`);
    assert.ok(Math.abs(js.qty - py.qty) <= 1e-9 * Math.max(1, py.qty), `qty ${js.qty} vs ${py.qty}`);
    if (py.qty > 0) {
      assert.ok(Math.abs(js.risk_usdt - py.risk_usdt) <= 1e-9 * py.risk_usdt + 1e-12);
      assert.ok(Math.abs(js.liq_price - py.liq_price) <= 1e-9 * py.liq_price);
      assert.ok(js.risk_usdt <= c.input.equity * c.input.risk_frac + 1e-9, "never above the per-trade budget");
      assert.ok(js.notional <= c.input.equity * c.input.max_eff_lev + 1e-9, "never above the leverage cap");
    }
    n++;
  }
  assert.equal(n, 864);
});

test("sizing: quantities are exact multiples of the step (no float residue)", () => {
  assert.equal(stepsToDec(1234, "0.0001"), "0.1234"); assert.equal(stepsToDec(7, "0.01"), "0.07");
  assert.equal(stepsToDec(3, "1"), "3"); assert.equal(stepsToDec(5, "0.0001"), "0.0005");
  const r = sizePosition({ equity: 1000, entry: 64900, side: 1, stop_dist: 300, risk_frac: 0.0025, open_risk_usdt: 0, max_open_risk_frac: 0.01,
    open_notional: 0, max_eff_lev: 2, taker: 0.0006, slip_frac: 0.0002, min_qty: 0.0001, qty_step: 0.0001, min_notional: 5, exchange_lev: 2, mmr: 0.004, liq_multiple: 2 });
  assert.equal(r.code, "OK"); assert.match(r.qty_str, /^0\.\d{1,4}$/);
});

// ---------------------------------------------------------------- gate
const INS = { instrument_id: "bitget:perp:XRPUSDT", min_qty: "1", qty_step: "1", min_notional: "5" };
const snap = (o = {}) => ({ instrument_id: "bitget:perp:BTCUSDT", health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY" }, book_state: "VALID",
  coverage_complete: true, coverage_reasons: [], spread_bps: 0.5, atr_pct: 0.3, bid: 64899.9, ask: 64900, depth_10bps: { bid: 200000, ask: 200000 }, ...o });
const BTC = { instrument_id: "bitget:perp:BTCUSDT", min_qty: "0.0001", qty_step: "0.0001", min_notional: "5" };
const pf = (o = {}) => ({ analyst: "balanced", equity: 1000, peak_equity: 1000, day: { start_ts: 0, start_equity: 1000 }, positions: [], kill_switch: false, ...o });
const long = (stop = 64600) => ({ intent: "OPEN_LONG", stop });

test("gate: approves a clean setup and sizes it within the analyst's budget (buy at the ask)", () => {
  const r = evaluate({ analyst: "balanced", setup: long(), snapshot: snap(), portfolio: pf(), instrument: BTC });
  assert.equal(r.approved, true, r.reasons.join()); assert.equal(r.entry_reference, 64900);
  assert.ok(r.size.risk_usdt <= 2.5 + 1e-9);
  const d = evaluate({ analyst: "defensive", setup: long(), snapshot: snap(), portfolio: pf(), instrument: BTC });
  const t = evaluate({ analyst: "risk_taker", setup: long(), snapshot: snap(), portfolio: pf(), instrument: BTC });
  assert.ok(d.size.qty < r.size.qty && r.size.qty < t.size.qty, "budgets 0.10% < 0.25% < 0.50%");
});

test("gate: data integrity is mandatory for every analyst (stale feed, invalid book, coverage gap, unknown spread)", () => {
  for (const a of ["risk_taker", "balanced", "defensive"]) {
    assert.ok(evaluate({ analyst: a, setup: long(), snapshot: snap({ health: { ticker: "STALE", books: "HEALTHY", trade: "HEALTHY" } }), portfolio: pf(), instrument: BTC }).reasons.includes("DATA_STALE"));
    assert.ok(evaluate({ analyst: a, setup: long(), snapshot: snap({ book_state: "INVALID" }), portfolio: pf(), instrument: BTC }).reasons.includes("BOOK_INVALID"));
    assert.ok(evaluate({ analyst: a, setup: long(), snapshot: snap({ coverage_complete: false }), portfolio: pf(), instrument: BTC }).reasons.includes("COVERAGE_GAP"));
    assert.ok(evaluate({ analyst: a, setup: long(), snapshot: snap({ spread_bps: NaN }), portfolio: pf(), instrument: BTC }).reasons.includes("SPREAD_UNKNOWN"));
  }
});

test("gate: daily loss and drawdown suspensions include unrealised losses; kill switch blocks", () => {
  const losing = pf({ positions: [{ instrument_id: "bitget:perp:ETHUSDT", side: 1, qty: 1, entry: 2000, stop: 1900, mark: 1975 }] });
  assert.ok(evaluate({ analyst: "balanced", setup: long(), snapshot: snap(), portfolio: losing, instrument: BTC }).reasons.includes("DAILY_LOSS_SUSPENDED"), "-25 of 1000 = -2.5%");
  const dd = pf({ equity: 949, peak_equity: 1000, day: { start_ts: 0, start_equity: 949 } });
  assert.ok(evaluate({ analyst: "balanced", setup: long(), snapshot: snap(), portfolio: dd, instrument: BTC }).reasons.includes("DRAWDOWN_SUSPENDED"));
  assert.ok(evaluate({ analyst: "balanced", setup: long(), snapshot: snap(), portfolio: pf({ kill_switch: true }), instrument: BTC }).reasons.includes("KILL_SWITCH"));
});

test("gate: correlated bucket — open risk on another coin reduces what is left; second position on the same coin is refused", () => {
  const busy = pf({ positions: [{ instrument_id: "bitget:perp:ETHUSDT", side: 1, qty: 0.5, entry: 2000, stop: 1982, mark: 2000 }] });   // ~9.8 USDT at risk
  const r = evaluate({ analyst: "risk_taker", setup: long(), snapshot: snap(), portfolio: busy, instrument: BTC });
  assert.ok(r.reasons.includes("OPEN_RISK_LIMIT") || r.size.risk_usdt <= 10 - 9.8 + 1e-6, "combined open risk stays <= 1%");
  const same = pf({ positions: [{ instrument_id: "bitget:perp:BTCUSDT", side: 1, qty: 0.001, entry: 64000, stop: 63900, mark: 64000 }] });
  assert.ok(evaluate({ analyst: "balanced", setup: long(), snapshot: snap(), portfolio: same, instrument: BTC }).reasons.includes("POSITION_ALREADY_OPEN"));
});

test("gate S8: when even the minimum tradable size exceeds the budget the answer is NO_TRADE", () => {
  // Defensive budget 1 USDT; XRP at 0.96 with a 0.10 stop -> 1 XRP risks ~0.10 + costs -> fits; with a 1.5 stop it cannot
  const x = snap({ instrument_id: "bitget:perp:XRPUSDT", bid: 0.9606, ask: 0.9607 });
  const ok = evaluate({ analyst: "defensive", setup: long(0.86), snapshot: x, portfolio: pf(), instrument: INS });
  assert.equal(ok.approved, true, ok.reasons.join());
  const r = evaluate({ analyst: "defensive", setup: { intent: "OPEN_LONG", stop: 0.9607 - 1.5 * 0.9607 / 2 }, snapshot: x, portfolio: pf({ equity: 100, peak_equity: 100, day: { start_ts: 0, start_equity: 100 } }), instrument: INS });
  assert.equal(r.approved, false); assert.ok(r.reasons.includes("MIN_SIZE_EXCEEDS_BUDGET"), r.reasons.join());
});

test("gate: rejects non-open intents and stops on the wrong side; defaults match the documented test values", () => {
  assert.deepEqual(evaluate({ analyst: "balanced", setup: { intent: "WAIT" }, snapshot: snap(), portfolio: pf(), instrument: BTC }).reasons, ["NOT_AN_OPEN_INTENT"]);
  assert.ok(evaluate({ analyst: "balanced", setup: long(65000), snapshot: snap(), portfolio: pf(), instrument: BTC }).reasons.some(c => c === "STOP_ON_WRONG_SIDE" || c === "INVALID_INPUT"));
  assert.deepEqual(RISK_DEFAULTS.riskPerTrade, { defensive: 0.001, balanced: 0.0025, risk_taker: 0.005 });
  assert.equal(RISK_DEFAULTS.maxEffLev, 2); assert.equal(RISK_DEFAULTS.maxOpenRiskFrac, 0.01);
});

test("gate: position size must be small relative to visible depth on the side taken; unknown depth blocks", () => {
  assert.ok(evaluate({ analyst: "risk_taker", setup: long(), snapshot: snap({ depth_10bps: { bid: 200000, ask: 5000 } }), portfolio: pf(), instrument: BTC }).reasons.includes("SIZE_VS_DEPTH"));
  assert.ok(evaluate({ analyst: "risk_taker", setup: long(), snapshot: snap({ depth_10bps: null }), portfolio: pf(), instrument: BTC }).reasons.includes("DEPTH_UNKNOWN"));
  assert.equal(evaluate({ analyst: "risk_taker", setup: long(), snapshot: snap(), portfolio: pf(), instrument: BTC }).approved, true);
});
