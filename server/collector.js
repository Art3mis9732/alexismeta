"use strict";
/* Bitget collector: routes WS messages through validation -> book/health -> bounded store queue,
 * and repairs gaps with REST. One collector process per machine (browser tabs read from it via HTTP,
 * they never open their own upstream connections when the worker is used). */

const S = require("./schema");
const { fromBitgetContract } = require("./instruments");
const { OrderBook, STATES: BOOK } = require("./book");
const { WsSupervisor } = require("./adapters/bitget");

const PRODUCT = "USDT-FUTURES";
const CANDLE_CHANNELS = { candle1m: "1m", candle15m: "15m" };

class BitgetCollector {
  constructor({ rest, store, health, symbols, now = Date.now, WebSocketImpl, wsUrl, log = () => {},
                tickerSampleMs = 1000, bookSampleMs = 1000, bookTopLevels = 20, supervisorOpts = {} }) {
    Object.assign(this, { rest, store, health, symbols, now, log, tickerSampleMs, bookSampleMs, bookTopLevels });
    this.idOf = {}; this.books = {}; this.lastTickerSaved = {}; this.latestTicker = {}; this.lastBookSaved = {};
    this.resyncing = {};
    const subs = [];
    for (const s of symbols) for (const ch of ["ticker", "trade", "books", ...Object.keys(CANDLE_CHANNELS)]) subs.push({ instType: PRODUCT, channel: ch, instId: s });
    this.sup = new WsSupervisor(Object.assign({ subscriptions: subs, WebSocketImpl, url: wsUrl, now,
      onMessage: (m, recv, raw) => this.onMessage(m, recv, raw),
      onState: st => this.onSocketState(st),
      onFrame: () => this.health.onFrame(),
      onError: e => { this.log("ws: " + e.message); this.store.feedEvent("bitget:ws", "error", e.message); } }, supervisorOpts));
  }

  /** Load instrument identity from the live contracts endpoint; fall back to the last stored copy (flagged). */
  async loadInstruments() {
    try {
      const { body, recvTs } = await this.rest.contracts(PRODUCT);
      for (const sym of this.symbols) {
        const row = (body.data || []).find(c => c.symbol === sym);
        if (!row) throw new Error(`symbol ${sym} not in contracts`);
        const ins = fromBitgetContract(row, PRODUCT, recvTs);
        this.store.upsertInstrument(ins);
        this.idOf[sym] = ins.instrument_id;
      }
      this.store.feedEvent("bitget:contracts", "loaded", this.symbols.join(","));
      return { source: "live" };
    } catch (e) {
      for (const sym of this.symbols) {
        const cached = this.store.instruments().find(i => i.native_id === sym && i.product_type === PRODUCT);
        if (!cached) throw new Error(`no instrument metadata for ${sym}: ${e.message}`);
        this.idOf[sym] = cached.instrument_id;
      }
      this.store.feedEvent("bitget:contracts", "using_cached_metadata", e.message);
      return { source: "cached", error: e.message };
    }
  }

  registerFeeds() {
    for (const sym of this.symbols) {
      const id = this.idOf[sym];
      this.books[id] = new OrderBook(id);
      for (const k of ["ticker", "trade", "books", ...Object.keys(CANDLE_CHANNELS)]) this.health.register(`${id}|${k}`, k);
    }
  }

  async start() {
    await this.loadInstruments();
    this.registerFeeds();
    try { const c = await this.rest.clockOffset(); this.health.setClock(c.offset_ms, c.rtt_ms); } catch (e) { this.log("clock: " + e.message); }
    await this.backfillAll("startup");
    this.sup.start();
  }

  stop() { this.sup.stop(); }

  onSocketState(st) {
    this.health.onSocket(st);
    this.store.feedEvent("bitget:ws", st, null);
    if (st === "closed") for (const b of Object.values(this.books)) b.reset("disconnected");
    if (st === "open" && this.sup.stats.opens > 1) this.backfillAll("reconnect").catch(e => this.log("backfill: " + e.message));
  }

  /** REST candle backfill since the last final candle. Rows are marked source=bitget_rest_v2. */
  async backfillAll(why) {
    for (const sym of this.symbols) for (const [ch, iv] of Object.entries(CANDLE_CHANNELS)) {
      try {
        const { body, recvTs } = await this.rest.candles(sym, PRODUCT, iv, { limit: 1000 });
        const r = S.bitgetRestCandles(body, this.idOf[sym], iv, recvTs);
        if (!r.ok) { this.store.quarantine(S.SOURCE_REST, r.reason, body); continue; }
        const last = this.store.lastFinalCandleTs(this.idOf[sym], iv);
        r.events.forEach(e => this.store.enqueue(e));
        const first = r.events.length ? r.events[0].open_ts : null;
        if (last !== null && first !== null && first > last + S.INTERVAL_MS[iv]) {
          this.store.feedEvent(`${this.idOf[sym]}|${ch}`, "candle_gap_unrecoverable", `from ${last} to ${first} (REST window too short)`);
        }
        this.store.feedEvent(`${this.idOf[sym]}|${ch}`, "rest_backfill", `${why}: ${r.events.length} rows`);
      } catch (e) {
        this.store.feedEvent(`${this.idOf[sym]}|${ch}`, "rest_backfill_failed", e.message);
      }
    }
    if (why === "reconnect") for (const sym of this.symbols) this.store.feedEvent(`${this.idOf[sym]}|trade`, "possible_trade_gap", "trades during the disconnect are not recovered");
    this.store.flush();
  }

  onMessage(m, recv, raw) {
    if (m === null) { this.store.quarantine(S.SOURCE_WS, "unparseable", raw); return; }
    if (m.event) return;   // subscribe acks / errors (errors are logged by the supervisor)
    const arg = m.arg || {};
    const id = this.idOf[arg.instId];
    if (!id || arg.instType !== PRODUCT) { this.store.quarantine(S.SOURCE_WS, "unknown instrument/instType", raw); return; }
    const ch = arg.channel;
    let r;
    if (ch === "trade") r = S.bitgetTrades(m, id, recv);
    else if (ch === "ticker") r = S.bitgetTicker(m, id, recv);
    else if (CANDLE_CHANNELS[ch]) r = S.bitgetWsCandles(m, id, CANDLE_CHANNELS[ch], recv);
    else if (ch === "books") r = S.bitgetBook(m, id, recv);
    else { this.store.quarantine(S.SOURCE_WS, "unknown channel " + ch, raw); return; }
    if (!r.ok) { this.store.quarantine(S.SOURCE_WS, r.reason, raw); return; }
    const feed = `${id}|${ch}`;
    if (ch === "books") return this.onBook(id, arg.instId, r.events[0], feed);
    const lastEx = r.events.reduce((a, e) => Math.max(a, e.exch_ts), 0);
    this.health.onData(feed, lastEx);
    if (ch === "ticker") return this.onTicker(id, r.events[0]);
    for (const e of r.events) this.store.enqueue(e);
  }

  onTicker(id, ev) {
    this.latestTicker[id] = ev;
    if (ev.exch_ts - (this.lastTickerSaved[id] || 0) >= this.tickerSampleMs) { this.lastTickerSaved[id] = ev.exch_ts; this.store.enqueue(ev); }
  }

  onBook(id, sym, ev, feed) {
    const b = this.books[id];
    const res = b.apply(ev);
    if (res.ok) {
      this.health.onData(feed, ev.exch_ts);
      this.resyncing[id] = false;
      if (ev.exch_ts - (this.lastBookSaved[id] || 0) >= this.bookSampleMs) {
        this.lastBookSaved[id] = ev.exch_ts;
        const t = b.top(this.bookTopLevels);
        this.store.enqueue({ type: "book_top", instrument_id: id, exch_ts: ev.exch_ts, recv_ts: ev.recv_ts, seq: ev.seq, levels: this.bookTopLevels,
          bids_json: JSON.stringify(t.bids), asks_json: JSON.stringify(t.asks), source: S.SOURCE_WS, schema_version: ev.schema_version,
          quality: ev.checksum !== null ? ["checksum_present_unverified"] : [] });
      }
    } else if (res.invalid && !this.resyncing[id]) {
      this.resyncing[id] = true;
      this.store.feedEvent(feed, "book_invalid", res.reason);
      this.log(`book ${id} invalid (${res.reason}); resubscribing`);
      const a = { instType: PRODUCT, channel: "books", instId: sym };
      this.sup.send({ op: "unsubscribe", args: [a] });
      this.sup.send({ op: "subscribe", args: [a] });
    }
  }

  bookSummaries() { return Object.values(this.books).map(b => b.summary()); }
  bookTop(id, n) { const b = this.books[id]; return b ? { ...b.summary(), ...b.top(n) } : null; }
  bookValid(id) { const b = this.books[id]; return !!b && b.state === BOOK.VALID; }
}

module.exports = { BitgetCollector, PRODUCT, CANDLE_CHANNELS };
