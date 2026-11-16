"use strict";
/* Instrument identity, derived from the venue's own contract metadata (never hard-coded).
 *
 * Bitget Classic v2 USDT-FUTURES ("USDT-M perpetual"): order size is denominated in the BASE coin
 * (e.g. 0.01 BTC), margin and P&L settle in USDT -> a LINEAR contract with 1 base coin per unit of size.
 * `sizeMultiplier` is the size step (and `minTradeNum` the minimum size); it is NOT a contract value
 * multiplier. Source: field values observed from GET /api/v2/mix/market/contracts on 2026-11-16 and
 * the repo's existing usage (bgbot/sizing.py). */

const SCHEMA_VERSION = 1;

const DEC = /^-?\d+(\.\d+)?$/;

function classOfBitget(productType, symbolType) {
  if (productType === "SPOT") return "spot";
  if (symbolType === "perpetual") return "perpetual";
  if (symbolType === "delivery") return "dated_future";
  return "unknown";
}

/** Build the canonical instrument from one Bitget v2 contract row. Throws on missing identity fields. */
function fromBitgetContract(c, productType, fetchedTs) {
  if (!c || typeof c.symbol !== "string" || !c.baseCoin || !c.quoteCoin) throw new Error("contract row missing symbol/baseCoin/quoteCoin");
  const instClass = classOfBitget(productType, c.symbolType);
  if (instClass === "unknown") throw new Error(`unknown symbolType ${c.symbolType} for ${c.symbol}`);
  const settle = productType === "USDT-FUTURES" ? "USDT" : productType === "USDC-FUTURES" ? "USDC"
    : productType === "COIN-FUTURES" ? c.baseCoin : null;
  for (const k of ["minTradeNum", "sizeMultiplier"]) if (!DEC.test(String(c[k]))) throw new Error(`${c.symbol}: ${k} not a decimal`);
  const short = instClass === "perpetual" ? "perp" : instClass === "dated_future" ? "future" : "spot";
  return {
    instrument_id: `bitget:${short}:${c.symbol}`,
    venue: "bitget",
    native_id: c.symbol,
    product_type: productType,
    inst_class: instClass,
    base: c.baseCoin,
    quote: c.quoteCoin,
    settle,
    linear: productType === "COIN-FUTURES" ? 0 : 1,
    contract_value_basis: "base_coin_quantity",
    multiplier: "1",
    qty_step: String(c.sizeMultiplier),
    min_qty: String(c.minTradeNum),
    price_place: Number.parseInt(c.pricePlace, 10),
    min_notional: c.minTradeUSDT != null ? String(c.minTradeUSDT) : null,
    fund_interval_h: c.fundInterval != null ? Number.parseInt(c.fundInterval, 10) : null,
    status: c.symbolStatus || null,
    raw_json: JSON.stringify(c),
    fetched_ts: fetchedTs,
    schema_version: SCHEMA_VERSION
  };
}

/** Guard against the classic mapping bug: a spot symbol must never resolve to a perp id and vice versa. */
function assertClass(instrument, expected) {
  if (!instrument || instrument.inst_class !== expected)
    throw new Error(`instrument ${instrument && instrument.instrument_id} is ${instrument && instrument.inst_class}, expected ${expected}`);
  return instrument;
}

module.exports = { SCHEMA_VERSION, fromBitgetContract, assertClass, classOfBitget };
