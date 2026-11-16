"use strict";
/* Independent risk gate + position sizing. Runs AFTER an analyst policy and cannot be bypassed by it: a policy
 * only proposes; this module decides whether a PAPER position may be opened and how large.
 *
 * Defaults are ENGINEERING TEST DEFAULTS for paper trading (master prompt §11), not recommendations:
 *   1,000 USDT virtual equity per analyst; risk per trade Defensive 0.10% / Balanced 0.25% / Risk Taker 0.50%;
 *   combined open stop-risk <= 1%; daily loss suspension 2% (UTC day); peak drawdown suspension 5%;
 *   simulated leverage <= 2x (notional / equity); BTC, ETH and XRP treated as ONE correlated bucket.
 * Stops are not guaranteed maximum losses: gaps and slippage can exceed the modeled stop. */

const RISK_DEFAULTS = Object.freeze({
  equity0: 1000,
  riskPerTrade: { defensive: 0.001, balanced: 0.0025, risk_taker: 0.005 },
  maxOpenRiskFrac: 0.01, dailyLossFrac: 0.02, maxDrawdownFrac: 0.05,
  maxEffLev: 2, exchangeLev: 2, mmr: 0.004, taker: 0.0006, slipFrac: 0.0002, liqMultiple: 2,
  hardMaxSpreadBps: 10, hardMaxAtrPct: 3.0, minNotional: 5, maxDepthShare: 0.1
});

/* ---------- exact step arithmetic ---------- */
function decScale(step) { const s = String(step); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; }
/** steps * step as an exact decimal string (no binary float error). */
function stepsToDec(steps, step) {
  const sc = decScale(step), unit = BigInt(String(step).replace(".", "")), v = BigInt(steps) * unit;
  if (sc === 0) return v.toString();
  const neg = v < 0n, a = (neg ? -v : v).toString().padStart(sc + 1, "0");
  return (neg ? "-" : "") + a.slice(0, -sc) + "." + a.slice(-sc);
}

/** Port of bgbot/sizing.py size_position (same formulas, same 1e-9 rounding epsilon), plus reason codes. */
function sizePosition(p) {
  const res = (code, reason, extra = {}) => Object.assign({ qty: 0, qty_str: "0", code, reason, notional: 0, risk_usdt: 0, margin: 0, liq_price: 0,
    stop_price: 0, entry_fee: 0, est_round_trip_cost: 0, effective_leverage: 0 }, extra);
  if (!(p.equity > 0) || !(p.entry > 0) || !(p.stop_dist > 0)) return res("INVALID_INPUT", "invalid inputs");
  const perUnitCost = p.entry * 2 * (p.taker + p.slip_frac), perUnitRisk = p.stop_dist + perUnitCost;
  const budget = Math.min(p.equity * p.risk_frac, p.equity * p.max_open_risk_frac - p.open_risk_usdt);
  if (budget <= 0) return res("OPEN_RISK_LIMIT", "portfolio open-risk limit reached");
  let qty = budget / perUnitRisk;
  qty = Math.min(qty, Math.max(0, p.equity * p.max_eff_lev - p.open_notional) / p.entry);
  const steps = Math.floor(qty / p.qty_step + 1e-9);
  const qtyStr = stepsToDec(steps, p.qty_step), q = Number(qtyStr);
  if (q < p.min_qty) return res("MIN_SIZE_EXCEEDS_BUDGET", `below exchange minimum (${q} < ${p.min_qty}): the minimum tradable size would exceed the risk budget`);
  const notional = q * p.entry;
  if (notional < p.min_notional) return res("MIN_NOTIONAL", `notional ${notional.toFixed(2)} < minimum ${p.min_notional}`);
  const stopPrice = p.entry - p.side * p.stop_dist;
  const liq = p.side > 0 ? p.entry * (1 - 1 / p.exchange_lev) / (1 - p.mmr - p.taker) : p.entry * (1 + 1 / p.exchange_lev) / (1 + p.mmr + p.taker);
  if (Math.abs(p.entry - liq) < p.liq_multiple * p.stop_dist) return res("LIQ_TOO_CLOSE", `liquidation ${liq.toFixed(2)} too close`, { liq_price: liq, stop_price: stopPrice });
  return { qty: q, qty_str: qtyStr, code: "OK", reason: "ok", notional, risk_usdt: q * perUnitRisk, margin: notional / p.exchange_lev, liq_price: liq,
    stop_price: stopPrice, entry_fee: notional * p.taker, est_round_trip_cost: q * perUnitCost, effective_leverage: notional / p.equity };
}

/* ---------- portfolio-level state needed by the gate ---------- */
/** portfolio = { analyst, equity (realised), peak_equity, day: {start_ts, start_equity, realised}, positions: [{instrument_id, side, qty, entry, stop, mark}] , kill_switch } */
/** Modelled loss if every open stop fills at its price: distance from the FILL price to the stop, plus both taker fees
 *  and the EXIT slippage. Entry slippage is already inside the fill price, so it is not added again. */
function openRisk(portfolio) {
  return portfolio.positions.reduce((a, p) => a + Math.max(0, p.side * (p.entry - p.stop)) * p.qty + p.entry * p.qty * (2 * RISK_DEFAULTS.taker + RISK_DEFAULTS.slipFrac), 0);
}
function openNotional(portfolio) { return portfolio.positions.reduce((a, p) => a + Math.abs(p.qty * (p.mark || p.entry)), 0); }
function unrealised(portfolio) { return portfolio.positions.reduce((a, p) => a + p.side * ((p.mark || p.entry) - p.entry) * p.qty, 0); }

/**
 * Decide whether a proposed OPEN_* setup may become a paper position.
 * @returns {approved:boolean, reasons:[code...], size:object|null, checks:{...}}
 */
function evaluate({ analyst, setup, snapshot, portfolio, instrument, config = RISK_DEFAULTS }) {
  const reasons = [], checks = {};
  const fail = (code, detail) => { reasons.push(code); checks[code] = detail === undefined ? true : detail; };
  if (!setup || (setup.intent !== "OPEN_LONG" && setup.intent !== "OPEN_SHORT")) return { approved: false, reasons: ["NOT_AN_OPEN_INTENT"], size: null, checks };
  if (portfolio.kill_switch) fail("KILL_SWITCH");
  // mandatory data integrity: identical for every analyst
  const h = snapshot.health || {};
  for (const k of ["ticker", "books", "trade"]) if (h[k] !== "HEALTHY") fail("DATA_STALE", `${k} ${h[k] || "UNKNOWN"}`);
  if (snapshot.book_state !== "VALID") fail("BOOK_INVALID", snapshot.book_state || "UNKNOWN");
  if (!snapshot.coverage_complete) fail("COVERAGE_GAP", snapshot.coverage_reasons);
  const spread = snapshot.spread_bps;
  if (!Number.isFinite(spread)) fail("SPREAD_UNKNOWN"); else if (spread > config.hardMaxSpreadBps) fail("SPREAD", spread);
  if (!Number.isFinite(snapshot.atr_pct)) fail("VOLATILITY_UNKNOWN"); else if (snapshot.atr_pct > config.hardMaxAtrPct) fail("VOLATILITY", snapshot.atr_pct);
  // portfolio limits (persisted state; includes unrealised P&L)
  const eqNow = portfolio.equity + unrealised(portfolio);
  if (eqNow - portfolio.day.start_equity <= -config.dailyLossFrac * portfolio.day.start_equity) fail("DAILY_LOSS_SUSPENDED", eqNow - portfolio.day.start_equity);
  if (eqNow <= portfolio.peak_equity * (1 - config.maxDrawdownFrac)) fail("DRAWDOWN_SUSPENDED", eqNow / portfolio.peak_equity - 1);
  if (portfolio.positions.some(p => p.instrument_id === snapshot.instrument_id)) fail("POSITION_ALREADY_OPEN");
  // sizing (correlated bucket: open risk and notional of ALL instruments count)
  const side = setup.intent === "OPEN_LONG" ? 1 : -1;
  const entry = side > 0 ? snapshot.ask : snapshot.bid;               // a market buy pays the ask, a sell gets the bid
  let size = null;
  if (!(entry > 0)) fail("NO_EXECUTABLE_PRICE");
  else {
    size = sizePosition({ equity: eqNow, entry, side, stop_dist: side * (entry - setup.stop), risk_frac: config.riskPerTrade[analyst],
      open_risk_usdt: openRisk(portfolio), max_open_risk_frac: config.maxOpenRiskFrac, open_notional: openNotional(portfolio),
      max_eff_lev: config.maxEffLev, taker: config.taker, slip_frac: config.slipFrac, min_qty: Number(instrument.min_qty),
      qty_step: Number(instrument.qty_step), min_notional: Number(instrument.min_notional || config.minNotional),
      exchange_lev: config.exchangeLev, mmr: config.mmr, liq_multiple: config.liqMultiple });
    if (size.code !== "OK") fail(size.code, size.reason);
    // liquidity: our notional must be small relative to the visible book within 10 bps on the side we take
    const dep = snapshot.depth_10bps;
    if (!dep || !Number.isFinite(side > 0 ? dep.ask : dep.bid)) fail("DEPTH_UNKNOWN");
    else if (size.code === "OK" && size.notional > config.maxDepthShare * (side > 0 ? dep.ask : dep.bid)) fail("SIZE_VS_DEPTH", `${size.notional.toFixed(0)} > ${config.maxDepthShare} x ${(side > 0 ? dep.ask : dep.bid).toFixed(0)}`);
    if (!(side * (entry - setup.stop) > 0)) fail("STOP_ON_WRONG_SIDE");
  }
  return { approved: reasons.length === 0, reasons, size, checks, entry_reference: entry };
}

module.exports = { RISK_DEFAULTS, sizePosition, evaluate, stepsToDec, openRisk, openNotional, unrealised };
