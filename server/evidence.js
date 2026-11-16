"use strict";
/* Versioned evidence snapshot: the ONE input every analyst policy reads.
 *
 * Built only at a 15m bar close, only from final=1 candles that are contiguous across the lookback, plus the
 * microstructure observed at decision time (ticker, full order book), feed health and coverage. Missing or
 * inconsistent inputs are listed in `missing` (they are never replaced by zeros or defaults); policies return
 * NO_TRADE/UNKNOWN when anything they need is missing. The canonical JSON is hashed; the hash is what ledger
 * entries reference.
 *
 * Feature specs (evidence-v1). All prices in USDT, times UTC ms; "bar" = 15m Bitget USDT-perp trade-price candle.
 *   trend_1h      -1/0/+1. 1h closes built from complete 15m hours; +1 if close > EMA20 > EMA50 (hourly), -1 mirror.
 *                 Warm-up 50 complete hours. Source: docs/patterns.js hourTrend (unchanged legacy rule).
 *   vwap, above_vwap  session VWAP (typical price × base volume), reset 00:00 UTC; above = last close > vwap.
 *   atr, atr_pct  Wilder ATR(14) of the last bar; pct of last close.
 *   atr_pctile    fraction of the previous 960 bars (10 days) whose ATR% is <= the current ATR%. Warm-up 100 bars.
 *   change_24h    last close / close 96 bars earlier - 1.
 *   rv_24h        stdev of 96 bar log returns × sqrt(96) (daily-scaled), informational.
 *   triggers      legacy engine events completed ON the last bar (code, dir, stop, level).
 *   spread_bps    (ask - bid) / mid × 1e4 from the ticker received at or before decision time.
 *   depth_10bps   USDT notional within ±10 bps of mid, per side, from the FULL in-memory book (not the stored top-20).
 * Availability: every value is known at decision_ts (bar close + finalisation delay). No future bars are used. */

const crypto = require("node:crypto");
const Pt = require("../docs/patterns.js");
const { canonical } = require("./ledger");

const EVIDENCE_VERSION = "evidence-v1";
const BAR = 900000, LOOKBACK = 1000, MIN_BARS = 300;

function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

/** Pure part: candles (final, ascending) + micro + health -> snapshot. Exported for tests and replay. */
function buildFromInputs({ instrumentId, barCloseTs, decisionTs, candles, ticker, book, health, coverage }) {
  const missing = [];
  const c = candles.map(r => ({ t: r.open_ts, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.base_vol, final: r.final }));
  if (c.length < MIN_BARS) missing.push(`candles: ${c.length} < ${MIN_BARS} bars`);
  if (c.some(x => x.final !== 1)) missing.push("candles: non-final bar in lookback");
  for (let i = 1; i < c.length; i++) if (c[i].t - c[i - 1].t !== BAR) { missing.push(`candles: gap after ${new Date(c[i - 1].t).toISOString()}`); break; }
  if (c.length && c[c.length - 1].t + BAR !== barCloseTs) missing.push("candles: last bar does not close at the decision bar close");

  const snap = { schema: EVIDENCE_VERSION, instrument_id: instrumentId, bar_close_ts: barCloseTs, decision_ts: decisionTs,
    candles: { interval: "15m", count: c.length, first_open: c.length ? c[0].t : null, last_open: c.length ? c[c.length - 1].t : null,
      rows_hash: sha(canonical(candles.map(r => [r.open_ts, r.o, r.h, r.l, r.c, r.base_vol]))) } };

  if (c.length >= MIN_BARS) {
    const res = Pt.analyze(c), n = c.length, i = n - 1, A = res.atr;
    const px = c[i].c;
    snap.close = px; snap.trend_1h = res.trend[i]; snap.vwap = res.vwap[i]; snap.above_vwap = px > res.vwap[i];
    snap.atr = A[i]; snap.atr_pct = A[i] !== null ? A[i] / px * 100 : null;
    const hist = []; for (let k = Math.max(14, i - 960); k < i; k++) if (A[k] !== null) hist.push(A[k] / c[k].c);
    snap.atr_pctile = hist.length >= 100 && A[i] !== null ? hist.filter(x => x <= A[i] / px).length / hist.length : null;
    if (snap.atr_pctile === null) missing.push("atr_pctile: warm-up");
    snap.change_24h = n > 96 ? px / c[i - 96].c - 1 : null;
    if (n > 96) { const r = []; for (let k = i - 95; k <= i; k++) r.push(Math.log(c[k].c / c[k - 1].c)); const m = r.reduce((a, b) => a + b, 0) / r.length;
      snap.rv_24h = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(96); } else snap.rv_24h = null;
    snap.triggers = res.events.filter(e => e.i === i && e.dir !== 0).map(e => ({ code: e.code, name: e.name, dir: e.dir, stop: e.stop, level: e.level }));
  } else snap.triggers = [];

  // microstructure at decision time
  if (ticker && ticker.recv_ts <= decisionTs) {
    const bid = ticker.bid === null ? null : +ticker.bid, ask = ticker.ask === null ? null : +ticker.ask;
    snap.bid = bid; snap.ask = ask; snap.last = +ticker.last;
    snap.mark = ticker.mark === null ? null : +ticker.mark; snap.index = ticker.index_px === null ? null : +ticker.index_px;
    snap.funding_rate = ticker.funding_rate === null ? null : +ticker.funding_rate;
    snap.spread_bps = bid && ask ? (ask - bid) / ((ask + bid) / 2) * 1e4 : null;
    snap.ticker_recv_ts = ticker.recv_ts;
    if (snap.spread_bps === null) missing.push("spread: bid/ask missing");
  } else { missing.push("ticker: none at decision time"); snap.spread_bps = null; snap.bid = snap.ask = null; }
  snap.book_state = book ? book.state : "UNKNOWN";
  if (book && book.state === "VALID" && snap.bid && snap.ask) {
    const mid = (snap.bid + snap.ask) / 2, band = (L) => L.filter(([p]) => Math.abs(+p / mid - 1) * 1e4 <= 10).reduce((a, [p, q]) => a + +p * +q, 0);
    snap.depth_10bps = { bid: band(book.bids), ask: band(book.asks) };
  } else snap.depth_10bps = null;
  snap.health = health || {};
  snap.coverage_complete = !!(coverage && coverage.every(x => x.complete));
  snap.coverage_reasons = coverage ? [...new Set(coverage.flatMap(x => x.reasons))] : ["coverage: not checked"];
  snap.missing = missing;
  snap.data_cutoff_ts = Math.max(snap.candles.last_open !== null ? snap.candles.last_open + BAR : 0, snap.ticker_recv_ts || 0, book && book.recv_ts ? book.recv_ts : 0) || null;
  if (snap.data_cutoff_ts !== null && snap.data_cutoff_ts > decisionTs) missing.push("data_cutoff after decision time");
  snap.hash = sha(canonical(snap));
  return snap;
}

/** Live: gather inputs from the store and the collector at decision time. */
function buildLive({ store, collector, health, instrumentId, barCloseTs, decisionTs, coverageWindowMs = 15 * 60000 }) {
  const candles = store.candles(instrumentId, "15m", LOOKBACK, barCloseTs - BAR + 1);
  const ticker = collector.latestTicker[instrumentId] || null;
  const b = collector.books[instrumentId];
  const book = b ? { state: b.state, recv_ts: b.recvTs, ...b.top(1000) } : null;
  const hs = health.snapshot().feeds.filter(f => f.feed.startsWith(instrumentId + "|"));
  const H = {}; for (const f of hs) H[f.kind] = f.state;
  const from = decisionTs - coverageWindowMs;
  const coverage = ["ticker", "book", "trade"].map(k => store.coverage(instrumentId, k, from, decisionTs));
  return buildFromInputs({ instrumentId, barCloseTs, decisionTs, candles, ticker, book, health: H, coverage });
}

module.exports = { EVIDENCE_VERSION, buildFromInputs, buildLive, BAR };
