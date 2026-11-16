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
    this.resyncing = {}; this.bookInvalidSince = {}; this.downSince = null;
    this.lastOpen = {}; this.finalizing = false; this.finalizeTimer = null; this.setTimer = setTimeout; this.clearTimer = clearTimeout;
    this.finalizeDelayMs = 2500;
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

  /** On startup, the time since observation ended is a gap. Observation ended at the logged clean shutdown, or
   * (after a crash) at the last persisted message of ANY kind for the instrument. A quiet trade channel is not
   * "unobserved": trades simply did not happen while the ticker and book were still arriving. */
  recordDowntime(unclean, prevStopTs) {
    const now = this.now();
    for (const id of Object.values(this.idOf)) {
      const seen = ["trade", "ticker", "book"].map(k => this.store.lastRecvTs(id, k)).filter(t => t !== null);
      if (!seen.length) continue;                       // never observed: coverage() reports that by itself
      const from = !unclean && prevStopTs ? prevStopTs : Math.max(...seen);
      if (now > from) for (const kind of ["trade", "ticker", "book"]) this.store.addGap(id, kind, from, now, unclean ? "downtime_after_unclean_stop" : "downtime");
    }
  }

  async start({ unclean = false, prevStopTs = null } = {}) {
    await this.loadInstruments();
    this.registerFeeds();
    this.recordDowntime(unclean, prevStopTs);
    try { const c = await this.rest.clockOffset(); this.health.setClock(c.offset_ms, c.rtt_ms); } catch (e) { this.log("clock: " + e.message); }
    await this.backfillAll("startup");
    this.sup.start();
  }

  stop() { this.sup.stop(); if (this.finalizeTimer) this.clearTimer(this.finalizeTimer); this.finalizeTimer = null; }

  /* WS candle pushes stop when a bar ends; the last push can be seconds before the close, so a bar is never
   * finalised by the stream itself. Closed bars are therefore re-fetched over REST (final by requestTime).
   * Triggered shortly after a new bar opens, and by a periodic sweep (main.js) as a backstop. */
  scheduleFinalize() {
    if (this.finalizeTimer) return;
    this.finalizeTimer = this.setTimer(() => { this.finalizeTimer = null; this.finalizeSweep().catch(e => this.log("finalize: " + e.message)); }, this.finalizeDelayMs);
  }

  async finalizeSweep() {
    if (this.finalizing) return 0;
    this.finalizing = true; let fixed = 0;
    try {
      this.store.flush();
      for (const sym of this.symbols) for (const [ch, iv] of Object.entries(CANDLE_CHANNELS)) {
        const id = this.idOf[sym], ms = S.INTERVAL_MS[iv];
        const open = this.store.unfinalized(id, iv, ms, this.now() - 1000);
        if (!open.length) continue;
        const need = Math.min(1000, Math.ceil((this.now() - open[0]) / ms) + 2);
        try {
          const { body, recvTs } = await this.rest.candles(sym, PRODUCT, iv, { limit: need });
          const r = S.bitgetRestCandles(body, id, iv, recvTs);
          if (!r.ok) { this.store.quarantine(S.SOURCE_REST, r.reason, body); continue; }
          r.events.forEach(e => this.store.enqueue(e));
          this.store.flush();
          const left = this.store.unfinalized(id, iv, ms, Math.min(this.now() - 1000, Number(body.requestTime)));
          fixed += open.length - left.length;
          if (left.length) this.store.feedEvent(`${id}|${ch}`, "candle_not_finalized", `${left.length} closed bar(s) not returned by REST yet`);
        } catch (e) { this.store.feedEvent(`${id}|${ch}`, "finalize_failed", e.message); }
      }
    } finally { this.finalizing = false; }
    return fixed;
  }

  onSocketState(st) {
    const now = this.now();
    if (st === "closed" && this.downSince === null) {
      // observation ended at the last frame received (a silent socket may have been dead for a while before closing)
      const lf = this.health.socket.last_frame_ts;
      this.downSince = lf !== null && lf !== undefined ? Math.min(lf, now) : now;
    }
    if (st === "open" && this.downSince !== null) {
      for (const id of Object.values(this.idOf)) for (const kind of ["trade", "ticker", "book"]) this.store.addGap(id, kind, this.downSince, now, "ws_disconnect");
      this.downSince = null;
    }
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
    if (CANDLE_CHANNELS[ch] && m.action === "update") {
      const key = feed, newest = r.events.reduce((a, e) => Math.max(a, e.open_ts), 0);
      if (this.lastOpen[key] !== undefined && newest > this.lastOpen[key]) this.scheduleFinalize();
      this.lastOpen[key] = Math.max(this.lastOpen[key] || 0, newest);
    }
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
      if (this.bookInvalidSince[id] !== undefined) { this.store.addGap(id, "book", this.bookInvalidSince[id], ev.recv_ts, "book_invalid"); delete this.bookInvalidSince[id]; }
      if (ev.exch_ts - (this.lastBookSaved[id] || 0) >= this.bookSampleMs) {
        this.lastBookSaved[id] = ev.exch_ts;
        const t = b.top(this.bookTopLevels);
        this.store.enqueue({ type: "book_top", instrument_id: id, exch_ts: ev.exch_ts, recv_ts: ev.recv_ts, seq: ev.seq, levels: this.bookTopLevels,
          bids_json: JSON.stringify(t.bids), asks_json: JSON.stringify(t.asks), source: S.SOURCE_WS, schema_version: ev.schema_version,
          quality: ev.checksum !== null ? ["checksum_present_unverified"] : [] });
      }
    } else if (res.invalid && !this.resyncing[id]) {
      this.resyncing[id] = true; this.bookInvalidSince[id] = ev.recv_ts;
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
