"use strict";
/* Point-in-time evidence snapshots for historical replay: the LIVE builder (server/evidence.js buildFromInputs) fed with history.
 *
 * VARIANT "candle-only-v1": everything derived from 15m candles is computed by the same code as live and uses only bars that had closed at the decision time.
 * Microstructure has NO history, so it is ASSUMED benign and the assumption is part of the variant's identity:
 *   spread = one tick (the measured forward median per instrument), depth = a fixed amount above every analyst's minimum, health/coverage complete, funding unknown.
 * Results from this variant are therefore an UPPER BOUND on what the rules could do live (live may add spread/depth/data-quality refusals), never an exact replay. */
const { buildFromInputs, BAR } = require("../server/evidence");
const VARIANT = "candle-only-v1";
const MICRO = Object.freeze({ spread_bps: { BTCUSDT: 0.016, ETHUSDT: 0.055, XRPUSDT: 1.046 }, depth_usdt_per_side: 75000, source: "forward ticker medians 2026-11-16/17 (one tick); depth = 3x the Defensive minimum (assumption)" });
const LOOKBACK = 1000;

/** snapshot for the bar that CLOSES at barCloseTs, built from rows[0..i] where rows[i].open_ts + BAR === barCloseTs. */
function snapshotAt(sym, rows, i, micro = MICRO) {
  const win = rows.slice(Math.max(0, i - LOOKBACK + 1), i + 1), last = win[win.length - 1], barCloseTs = last.open_ts + BAR, decisionTs = barCloseTs + 3000;
  const px = +last.c, s = micro.spread_bps[sym], bid = px * (1 - s / 2e4), ask = px * (1 + s / 2e4), half = micro.depth_usdt_per_side / px;
  const ticker = { recv_ts: decisionTs - 100, bid: String(bid), ask: String(ask), last: String(px), mark: String(px), index_px: String(px), funding_rate: null };
  const book = { state: "VALID", bids: [[String(bid), String(half)]], asks: [[String(ask), String(half)]] };
  const health = { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" };
  const snap = buildFromInputs({ instrumentId: "bitget:perp:" + sym, barCloseTs, decisionTs, candles: win, ticker, book, health, coverage: [{ complete: true, reasons: [] }, { complete: true, reasons: [] }] });
  snap.variant = VARIANT; return snap;
}
/** All snapshots for a symbol from the first index with enough history (evidence-v1 needs MIN_BARS=300 contiguous bars). Contiguity is checked by the builder itself. */
function buildAll(sym, rows, { from = 300, to = rows.length - 1, micro = MICRO } = {}) { const out = []; for (let i = from; i <= to; i++) out.push(snapshotAt(sym, rows, i, micro)); return out; }
module.exports = { VARIANT, MICRO, LOOKBACK, snapshotAt, buildAll, BAR };
