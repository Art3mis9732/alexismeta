"use strict";
/* Canonical market events and validation. Every normaliser returns either
 *   { ok: true, events: [...] }  or  { ok: false, reason }   (the caller quarantines the raw message).
 *
 * Decimal values are kept as the exchange's exact strings (lossless). Analytics parse them with
 * explicit tolerances later; nothing here converts money to binary floating point for storage.
 * Missing optional values become null (never 0) and are listed in `quality`. */

const { SCHEMA_VERSION } = require("./instruments");

const DEC = /^-?\d+(\.\d+)?$/;
const MIN_TS = Date.UTC(2017, 0, 1), MAX_FUTURE_MS = 86400000;
const INTERVAL_MS = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1H": 3600000, "4H": 14400000, "1D": 86400000 };

const isDec = v => typeof v === "string" && DEC.test(v);
const posDec = v => isDec(v) && Number(v) > 0;
const nonNegDec = v => isDec(v) && Number(v) >= 0;
function tsOk(t, now) { return Number.isSafeInteger(t) && t >= MIN_TS && t <= now + MAX_FUTURE_MS; }
function toTs(v) { const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN; return n; }
function optDec(v, name, quality) { if (v === undefined || v === null || v === "") { quality.push("missing_" + name); return null; } if (!isDec(v)) { quality.push("bad_" + name); return null; } return v; }

const SOURCE_WS = "bitget_ws_v2_public", SOURCE_REST = "bitget_rest_v2";

/** Bitget WS `trade` channel -> trade events. `side` is stored raw as venue_side (aggressor meaning unverified, D-008). */
function bitgetTrades(msg, instrumentId, recvTs) {
  if (!Array.isArray(msg.data)) return { ok: false, reason: "trade: data not an array" };
  const ev = [];
  for (const d of msg.data) {
    const t = toTs(d && d.ts);
    if (!d || !tsOk(t, recvTs)) return { ok: false, reason: "trade: bad ts" };
    if (!posDec(d.price) || !posDec(d.size)) return { ok: false, reason: "trade: bad price/size" };
    if (typeof d.tradeId !== "string" || !/^\d+$/.test(d.tradeId)) return { ok: false, reason: "trade: bad tradeId" };
    if (d.side !== "buy" && d.side !== "sell") return { ok: false, reason: "trade: bad side" };
    ev.push({ type: "trade", instrument_id: instrumentId, trade_id: d.tradeId, exch_ts: t, recv_ts: recvTs, price: d.price, size: d.size,
      venue_side: d.side, source: SOURCE_WS, schema_version: SCHEMA_VERSION, quality: ["aggressor_semantics_unverified"] });
  }
  return { ok: true, events: ev };
}

/** Candle rows [ts,o,h,l,c,baseVol,quoteVol,...]. A candle is FINAL only when its interval has ended by the
 * exchange's own push time (`refTs`): open + interval <= refTs. Otherwise it is the forming (partial) candle. */
function candleRows(rows, instrumentId, interval, refTs, recvTs, source) {
  const ms = INTERVAL_MS[interval];
  if (!ms) return { ok: false, reason: "candle: unknown interval " + interval };
  if (!Array.isArray(rows)) return { ok: false, reason: "candle: data not an array" };
  if (!tsOk(refTs, recvTs)) return { ok: false, reason: "candle: bad reference ts" };
  const ev = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) return { ok: false, reason: "candle: short row" };
    const t = toTs(r[0]);
    if (!tsOk(t, recvTs) || t % ms !== 0) return { ok: false, reason: "candle: bad open ts" };
    const [o, h, l, c, bv] = r.slice(1, 6), qv = r[6];
    if (![o, h, l, c].every(posDec) || !nonNegDec(bv)) return { ok: false, reason: "candle: bad ohlcv" };
    const H = Number(h), L = Number(l);
    if (H < L || Number(o) > H || Number(o) < L || Number(c) > H || Number(c) < L) return { ok: false, reason: "candle: high/low inconsistent" };
    const quality = [];
    ev.push({ type: "candle", instrument_id: instrumentId, interval, open_ts: t, o, h, l, c, base_vol: bv,
      quote_vol: optDec(qv, "quote_vol", quality), final: t + ms <= refTs ? 1 : 0, exch_ts: refTs, recv_ts: recvTs,
      source, schema_version: SCHEMA_VERSION, quality });
  }
  return { ok: true, events: ev };
}

function bitgetWsCandles(msg, instrumentId, interval, recvTs) {
  return candleRows(msg.data, instrumentId, interval, toTs(msg.ts), recvTs, SOURCE_WS);
}

/** REST /api/v2/mix/market/candles: `requestTime` is the exchange reference time for finality. */
function bitgetRestCandles(body, instrumentId, interval, recvTs) {
  return candleRows(body && body.data, instrumentId, interval, toTs(body && body.requestTime), recvTs, SOURCE_REST);
}

/** WS `ticker`: last, bid/ask, mark and index kept as distinct fields. Funding/OI missing -> null + quality flag. */
function bitgetTicker(msg, instrumentId, recvTs) {
  const d = Array.isArray(msg.data) ? msg.data[0] : null;
  if (!d) return { ok: false, reason: "ticker: no data" };
  const t = toTs(d.ts);
  if (!tsOk(t, recvTs)) return { ok: false, reason: "ticker: bad ts" };
  if (!posDec(d.lastPr)) return { ok: false, reason: "ticker: bad lastPr" };
  const q = [];
  const bid = optDec(d.bidPr, "bid", q), ask = optDec(d.askPr, "ask", q);
  if (bid !== null && ask !== null && Number(bid) > Number(ask)) q.push("crossed_top");
  const nft = toTs(d.nextFundingTime);
  return { ok: true, events: [{ type: "ticker", instrument_id: instrumentId, exch_ts: t, recv_ts: recvTs,
    last: d.lastPr, bid, ask, bid_sz: optDec(d.bidSz, "bid_sz", q), ask_sz: optDec(d.askSz, "ask_sz", q),
    mark: optDec(d.markPrice, "mark", q), index_px: optDec(d.indexPrice, "index", q),
    funding_rate: optDec(d.fundingRate, "funding_rate", q), next_funding_ts: Number.isSafeInteger(nft) && nft > 0 ? nft : null,
    open_interest: optDec(d.holdingAmount, "open_interest", q), oi_unit: "base_coin",
    source: SOURCE_WS, schema_version: SCHEMA_VERSION, quality: q }] };
}

/** WS `books` (full depth, incremental). Structural validation only; continuity is checked in book.js. */
function bitgetBook(msg, instrumentId, recvTs) {
  const d = Array.isArray(msg.data) ? msg.data[0] : null;
  if (!d) return { ok: false, reason: "book: no data" };
  if (msg.action !== "snapshot" && msg.action !== "update") return { ok: false, reason: "book: unknown action" };
  const t = toTs(d.ts);
  if (!tsOk(t, recvTs)) return { ok: false, reason: "book: bad ts" };
  if (!Number.isSafeInteger(d.seq) || !Number.isSafeInteger(d.pseq)) return { ok: false, reason: "book: bad seq/pseq" };
  for (const side of ["bids", "asks"]) {
    if (!Array.isArray(d[side])) return { ok: false, reason: "book: " + side + " not array" };
    for (const lv of d[side]) if (!Array.isArray(lv) || !isDec(lv[0]) || !isDec(lv[1])) return { ok: false, reason: "book: bad level" };
  }
  return { ok: true, events: [{ type: "book", action: msg.action, instrument_id: instrumentId, exch_ts: t, recv_ts: recvTs,
    seq: d.seq, pseq: d.pseq, bids: d.bids, asks: d.asks, checksum: d.checksum === undefined ? null : d.checksum,
    source: SOURCE_WS, schema_version: SCHEMA_VERSION }] };
}

module.exports = { INTERVAL_MS, SOURCE_WS, SOURCE_REST, bitgetTrades, bitgetWsCandles, bitgetRestCandles, bitgetTicker, bitgetBook, isDec };
