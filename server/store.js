"use strict";
/* SQLite (WAL) storage via node:sqlite. Single writer: only the worker process opens the DB for writing.
 * Writes are queued in a bounded buffer and flushed in one transaction (default every 250 ms).
 * All inserts are idempotent; see the per-table rules below. */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = [
  // v1: market data + audit tables
  `CREATE TABLE IF NOT EXISTS instruments (
     instrument_id TEXT PRIMARY KEY, venue TEXT NOT NULL, native_id TEXT NOT NULL, product_type TEXT NOT NULL,
     inst_class TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, settle TEXT, linear INTEGER NOT NULL,
     contract_value_basis TEXT NOT NULL, multiplier TEXT NOT NULL, qty_step TEXT NOT NULL, min_qty TEXT NOT NULL,
     price_place INTEGER, min_notional TEXT, fund_interval_h INTEGER, status TEXT, raw_json TEXT NOT NULL,
     fetched_ts INTEGER NOT NULL, schema_version INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS trades (
     instrument_id TEXT NOT NULL, trade_id TEXT NOT NULL, exch_ts INTEGER NOT NULL, recv_ts INTEGER NOT NULL,
     persist_ts INTEGER NOT NULL, price TEXT NOT NULL, size TEXT NOT NULL, venue_side TEXT NOT NULL, source TEXT NOT NULL,
     schema_version INTEGER NOT NULL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, trade_id)) WITHOUT ROWID;
   CREATE INDEX IF NOT EXISTS trades_by_ts ON trades (instrument_id, exch_ts);
   CREATE TABLE IF NOT EXISTS candles (
     instrument_id TEXT NOT NULL, interval TEXT NOT NULL, open_ts INTEGER NOT NULL, o TEXT NOT NULL, h TEXT NOT NULL,
     l TEXT NOT NULL, c TEXT NOT NULL, base_vol TEXT NOT NULL, quote_vol TEXT, final INTEGER NOT NULL, exch_ts INTEGER NOT NULL,
     recv_ts INTEGER NOT NULL, persist_ts INTEGER NOT NULL, source TEXT NOT NULL, schema_version INTEGER NOT NULL,
     quality TEXT NOT NULL, PRIMARY KEY (instrument_id, interval, open_ts)) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS tickers (
     instrument_id TEXT NOT NULL, exch_ts INTEGER NOT NULL, recv_ts INTEGER NOT NULL, persist_ts INTEGER NOT NULL,
     last TEXT NOT NULL, bid TEXT, ask TEXT, bid_sz TEXT, ask_sz TEXT, mark TEXT, index_px TEXT, funding_rate TEXT,
     next_funding_ts INTEGER, open_interest TEXT, oi_unit TEXT, source TEXT NOT NULL, schema_version INTEGER NOT NULL,
     quality TEXT NOT NULL, PRIMARY KEY (instrument_id, exch_ts)) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS book_tops (
     instrument_id TEXT NOT NULL, exch_ts INTEGER NOT NULL, recv_ts INTEGER NOT NULL, persist_ts INTEGER NOT NULL,
     seq INTEGER NOT NULL, levels INTEGER NOT NULL, bids_json TEXT NOT NULL, asks_json TEXT NOT NULL, source TEXT NOT NULL,
     schema_version INTEGER NOT NULL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, exch_ts)) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS quarantine (
     id INTEGER PRIMARY KEY, recv_ts INTEGER NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, raw TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS feed_events (
     id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, feed TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);`,
  // v2: append-only decision ledger (see server/ledger.js). The triggers make UPDATE and DELETE fail for every
  // writer, including this application. They do not make a locally editable file independently immutable;
  // the hash chain is what detects tampering.
  `CREATE TABLE IF NOT EXISTS ledger_entries (
     seq INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, ref_id TEXT REFERENCES ledger_entries(entry_id),
     created_ts INTEGER NOT NULL, data_cutoff_ts INTEGER, eval_due_ts INTEGER, code_rev TEXT NOT NULL, versions TEXT NOT NULL,
     payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
     CHECK (kind IN ('forecast','setup','decision','status','outcome')),
     CHECK (data_cutoff_ts IS NULL OR data_cutoff_ts <= created_ts),
     CHECK ((kind IN ('status','outcome')) = (ref_id IS NOT NULL)));
   CREATE INDEX IF NOT EXISTS ledger_by_ref ON ledger_entries (ref_id);
   CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
   CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`,
  // v3: (a) coverage gaps: periods when a feed was NOT observed (downtime, disconnects, invalid books), so that
  //     features and replay can tell "no data" from "nothing happened"; (b) ledger data_mode (LIVE / REPLAY), part
  //     of the hashed row, so replayed decisions can never be mistaken for recorded forward decisions.
  `CREATE TABLE IF NOT EXISTS coverage_gaps (
     id INTEGER PRIMARY KEY, instrument_id TEXT NOT NULL, kind TEXT NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL,
     reason TEXT NOT NULL, CHECK (to_ts >= from_ts));
   CREATE INDEX IF NOT EXISTS coverage_gaps_by_feed ON coverage_gaps (instrument_id, kind, from_ts);
   ALTER TABLE ledger_entries ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'LIVE' CHECK (data_mode IN ('LIVE', 'REPLAY'));`,
  // v4: paper trading working state. The LEDGER is the audit trail (every transition is appended there); these tables
  //     are the current state that must survive a restart (risk limits, open positions, kill switch).
  `CREATE TABLE IF NOT EXISTS evidence_snapshots (
     hash TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, bar_close_ts INTEGER NOT NULL, created_ts INTEGER NOT NULL, json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS evidence_by_bar ON evidence_snapshots (instrument_id, bar_close_ts);
   CREATE TABLE IF NOT EXISTS paper_portfolios (
     analyst TEXT PRIMARY KEY, equity REAL NOT NULL, peak_equity REAL NOT NULL, day_start_ts INTEGER NOT NULL, day_start_equity REAL NOT NULL,
     kill_switch INTEGER NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_positions (
     position_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, analyst TEXT NOT NULL, instrument_id TEXT NOT NULL, side INTEGER NOT NULL,
     qty TEXT NOT NULL, entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL, time_exit_ts INTEGER NOT NULL, opened_ts INTEGER NOT NULL,
     entry_fee REAL NOT NULL, funding REAL NOT NULL DEFAULT 0, last_trade_ts INTEGER NOT NULL, last_trade_id TEXT, next_funding_ts INTEGER,
     state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED')), exit_price REAL, exit_ts INTEGER, exit_reason TEXT, exit_fee REAL, pnl REAL,
     evaluable INTEGER, note TEXT);
   CREATE INDEX IF NOT EXISTS paper_positions_open ON paper_positions (state, analyst);`,
  // v5: official news. news_items holds the latest version; news_revisions keeps every earlier version with the time
  //     it was replaced, so a historical decision can be shown only what was known at its time.
  `CREATE TABLE IF NOT EXISTS news_items (
     item_id TEXT PRIMARY KEY, source TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
     published_ts INTEGER, discovered_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, event_type TEXT NOT NULL, assets TEXT NOT NULL,
     credibility TEXT NOT NULL, cluster_id TEXT NOT NULL, content_hash TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS news_by_discovery ON news_items (discovered_ts);
   CREATE TABLE IF NOT EXISTS news_revisions (
     id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, replaced_ts INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT, content_hash TEXT NOT NULL);`
];

const DEFAULT_RETENTION_MS = {
  trades: 3 * 86400000, book_tops: 2 * 86400000, tickers: 7 * 86400000,
  candles_1m: 90 * 86400000, quarantine: 7 * 86400000, feed_events: 30 * 86400000
};

class Store {
  constructor(file, { now = Date.now, maxQueue = 50000, retentionMs = DEFAULT_RETENTION_MS } = {}) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file; this.now = now; this.maxQueue = maxQueue; this.retentionMs = retentionMs;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this._migrate();
    this.queue = [];
    this.stats = { written: {}, unchanged: {}, dropped: 0, quarantined: 0, flushes: 0, last_flush_ms: 0 };
    this._prep();
  }

  _migrate() {
    const v = this.db.prepare("PRAGMA user_version").get().user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec("BEGIN");
      try { this.db.exec(MIGRATIONS[i]); this.db.exec(`PRAGMA user_version=${i + 1}`); this.db.exec("COMMIT"); }
      catch (e) { this.db.exec("ROLLBACK"); throw e; }
    }
  }

  _prep() {
    const d = this.db;
    this.st = {
      instrument: d.prepare(`INSERT INTO instruments VALUES (:instrument_id,:venue,:native_id,:product_type,:inst_class,:base,:quote,:settle,
          :linear,:contract_value_basis,:multiplier,:qty_step,:min_qty,:price_place,:min_notional,:fund_interval_h,:status,:raw_json,:fetched_ts,:schema_version)
        ON CONFLICT(instrument_id) DO UPDATE SET qty_step=excluded.qty_step, min_qty=excluded.min_qty, price_place=excluded.price_place,
          min_notional=excluded.min_notional, fund_interval_h=excluded.fund_interval_h, status=excluded.status, raw_json=excluded.raw_json,
          fetched_ts=excluded.fetched_ts, schema_version=excluded.schema_version`),
      trade: d.prepare(`INSERT OR IGNORE INTO trades VALUES (:instrument_id,:trade_id,:exch_ts,:recv_ts,:persist_ts,:price,:size,:venue_side,:source,:schema_version,:quality)`),
      // Candles: a FINAL candle is never overwritten by a partial one, nothing moves backwards in exchange time, and an
      // identical final row is a no-op (keeps the original provenance). A final row with different values is a correction.
      candle: d.prepare(`INSERT INTO candles VALUES (:instrument_id,:interval,:open_ts,:o,:h,:l,:c,:base_vol,:quote_vol,:final,:exch_ts,:recv_ts,:persist_ts,:source,:schema_version,:quality)
        ON CONFLICT(instrument_id, interval, open_ts) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, base_vol=excluded.base_vol,
          quote_vol=excluded.quote_vol, final=excluded.final, exch_ts=excluded.exch_ts, recv_ts=excluded.recv_ts, persist_ts=excluded.persist_ts,
          source=excluded.source, quality=excluded.quality
        WHERE NOT (candles.final = 1 AND excluded.final = 0) AND excluded.exch_ts >= candles.exch_ts
          AND NOT (candles.final = 1 AND excluded.final = 1 AND candles.o = excluded.o AND candles.h = excluded.h AND candles.l = excluded.l
                   AND candles.c = excluded.c AND candles.base_vol = excluded.base_vol)`),
      ticker: d.prepare(`INSERT OR IGNORE INTO tickers VALUES (:instrument_id,:exch_ts,:recv_ts,:persist_ts,:last,:bid,:ask,:bid_sz,:ask_sz,:mark,:index_px,
          :funding_rate,:next_funding_ts,:open_interest,:oi_unit,:source,:schema_version,:quality)`),
      book_top: d.prepare(`INSERT OR IGNORE INTO book_tops VALUES (:instrument_id,:exch_ts,:recv_ts,:persist_ts,:seq,:levels,:bids_json,:asks_json,:source,:schema_version,:quality)`),
      quarantine: d.prepare(`INSERT INTO quarantine (recv_ts, source, reason, raw) VALUES (?,?,?,?)`),
      feedEvent: d.prepare(`INSERT INTO feed_events (ts, feed, event, detail) VALUES (?,?,?,?)`)
    };
  }

  upsertInstrument(ins) { this.st.instrument.run(ins); }
  instruments() { return this.db.prepare("SELECT * FROM instruments ORDER BY instrument_id").all(); }
  instrument(id) { return this.db.prepare("SELECT * FROM instruments WHERE instrument_id=?").get(id) || null; }

  /** Bounded queue. On overflow the event is dropped, counted and logged; it is never silently lost. */
  enqueue(ev) {
    if (this.queue.length >= this.maxQueue) {
      this.stats.dropped++;
      if (this.stats.dropped === 1 || this.stats.dropped % 1000 === 0) this.feedEvent(ev.instrument_id || "store", "backpressure_drop", `dropped=${this.stats.dropped}`);
      return false;
    }
    this.queue.push(ev); return true;
  }

  flush() {
    if (!this.queue.length) return 0;
    const t0 = Date.now(), batch = this.queue; this.queue = [];
    const persist = this.now();
    this.db.exec("BEGIN");
    try {
      for (const ev of batch) {
        const row = { ...ev, persist_ts: persist, quality: JSON.stringify(ev.quality || []) };
        let r;
        if (ev.type === "trade") r = this.st.trade.run(pick(row, TRADE_COLS));
        else if (ev.type === "candle") r = this.st.candle.run(pick(row, CANDLE_COLS));
        else if (ev.type === "ticker") r = this.st.ticker.run(pick(row, TICKER_COLS));
        else if (ev.type === "book_top") r = this.st.book_top.run(pick(row, BOOK_COLS));
        else continue;
        const k = r.changes ? "written" : "unchanged";   // written = inserted or updated
        this.stats[k][ev.type] = (this.stats[k][ev.type] || 0) + 1;
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); this.queue = batch.concat(this.queue).slice(0, this.maxQueue); throw e; }
    this.stats.flushes++; this.stats.last_flush_ms = Date.now() - t0;
    return batch.length;
  }

  quarantine(source, reason, raw) {
    this.stats.quarantined++;
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    this.st.quarantine.run(this.now(), source, reason, s.slice(0, 4000));
  }
  feedEvent(feed, event, detail) { this.st.feedEvent.run(this.now(), feed, event, detail === undefined ? null : String(detail)); }

  // ---------- reads ----------
  candles(instrumentId, interval, limit = 500, before = null) {
    const rows = before === null
      ? this.db.prepare("SELECT * FROM candles WHERE instrument_id=? AND interval=? ORDER BY open_ts DESC LIMIT ?").all(instrumentId, interval, limit)
      : this.db.prepare("SELECT * FROM candles WHERE instrument_id=? AND interval=? AND open_ts<? ORDER BY open_ts DESC LIMIT ?").all(instrumentId, interval, before, limit);
    return rows.reverse();
  }
  /** Non-final candles whose interval has already ended by `refTs` (they need a REST finalisation). */
  unfinalized(instrumentId, interval, intervalMs, refTs) {
    return this.db.prepare("SELECT open_ts FROM candles WHERE instrument_id=? AND interval=? AND final=0 AND open_ts + ? <= ? ORDER BY open_ts")
      .all(instrumentId, interval, intervalMs, refTs).map(r => r.open_ts);
  }
  lastFinalCandleTs(instrumentId, interval) {
    const r = this.db.prepare("SELECT MAX(open_ts) AS t FROM candles WHERE instrument_id=? AND interval=? AND final=1").get(instrumentId, interval);
    return r && r.t !== null ? r.t : null;
  }
  latestTicker(instrumentId) { return this.db.prepare("SELECT * FROM tickers WHERE instrument_id=? ORDER BY exch_ts DESC LIMIT 1").get(instrumentId) || null; }
  trades(instrumentId, limit = 100) { return this.db.prepare("SELECT * FROM trades WHERE instrument_id=? ORDER BY exch_ts DESC, trade_id DESC LIMIT ?").all(instrumentId, limit); }
  count(table) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("bad table");
    return this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  lastWorkerEvent() { return this.db.prepare("SELECT * FROM feed_events WHERE feed='worker' AND event IN ('start','shutdown') ORDER BY id DESC LIMIT 1").get() || null; }
  feedEvents(limit = 50) { return this.db.prepare("SELECT * FROM feed_events ORDER BY id DESC LIMIT ?").all(limit); }

  // ---------- coverage ----------
  /** kind: trade | ticker | book. A gap means "not observed", never "nothing happened". */
  addGap(instrumentId, kind, fromTs, toTs, reason) {
    if (!(toTs >= fromTs)) return false;
    this.db.prepare("INSERT INTO coverage_gaps (instrument_id, kind, from_ts, to_ts, reason) VALUES (?,?,?,?,?)").run(instrumentId, kind, fromTs, toTs, reason);
    return true;
  }
  /** Most recent receipt time of persisted data for a feed kind (used to measure downtime after a restart/crash). */
  lastRecvTs(instrumentId, kind) {
    const t = { trade: "trades", ticker: "tickers", book: "book_tops" }[kind];
    if (!t) throw new Error("bad kind");
    const r = this.db.prepare(`SELECT MAX(recv_ts) AS t FROM ${t} WHERE instrument_id=?`).get(instrumentId);
    return r && r.t !== null ? r.t : null;
  }
  firstRecvTs(instrumentId, kind) {
    const t = { trade: "trades", ticker: "tickers", book: "book_tops" }[kind];
    const r = this.db.prepare(`SELECT MIN(recv_ts) AS t FROM ${t} WHERE instrument_id=?`).get(instrumentId);
    return r && r.t !== null ? r.t : null;
  }
  /** Was [fromTs, toTs] fully observed for this feed? Complete only if observation started before fromTs, no
   * recorded gap overlaps the window, and (when `liveUntil` is given) the feed was observed up to toTs. */
  coverage(instrumentId, kind, fromTs, toTs, { liveUntil = null } = {}) {
    const gaps = this.db.prepare("SELECT from_ts, to_ts, reason FROM coverage_gaps WHERE instrument_id=? AND kind=? AND to_ts > ? AND from_ts < ? ORDER BY from_ts")
      .all(instrumentId, kind, fromTs, toTs).map(g => ({ ...g }));
    const first = this.firstRecvTs(instrumentId, kind);
    const reasons = [];
    if (first === null || first > fromTs) reasons.push("observation_started_after_window_start");
    if (gaps.length) reasons.push("gap_in_window");
    if (liveUntil !== null && liveUntil < toTs) reasons.push("not_observed_until_window_end");
    return { complete: reasons.length === 0, reasons, gaps, first_observed_ts: first };
  }

  /** Delete rows past their retention window. Returns rows deleted per table. */
  prune(now = this.now()) {
    const R = this.retentionMs, out = {};
    const del = (k, sql, ...a) => { out[k] = Number(this.db.prepare(sql).run(...a).changes); };
    del("trades", "DELETE FROM trades WHERE exch_ts < ?", now - R.trades);
    del("book_tops", "DELETE FROM book_tops WHERE exch_ts < ?", now - R.book_tops);
    del("tickers", "DELETE FROM tickers WHERE exch_ts < ?", now - R.tickers);
    del("candles_1m", "DELETE FROM candles WHERE interval='1m' AND open_ts < ?", now - R.candles_1m);
    del("quarantine", "DELETE FROM quarantine WHERE recv_ts < ?", now - R.quarantine);
    del("feed_events", "DELETE FROM feed_events WHERE ts < ?", now - R.feed_events);
    return out;
  }

  sizeBytes() {
    if (this.file === ":memory:") return null;
    let n = 0; for (const f of [this.file, this.file + "-wal"]) { try { n += fs.statSync(f).size; } catch (e) { /* absent */ } }
    return n;
  }

  /** Consistent online backup (SQLite VACUUM INTO). */
  backup(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) throw new Error("backup target exists: " + dest);
    this.db.prepare("VACUUM INTO ?").run(dest);
    const chk = new DatabaseSync(dest, { readOnly: true });
    try { const r = chk.prepare("PRAGMA integrity_check").get(); return { file: dest, integrity: Object.values(r)[0] }; } finally { chk.close(); }
  }

  close() { try { this.flush(); } finally { this.db.close(); } }
}

const TRADE_COLS = ["instrument_id", "trade_id", "exch_ts", "recv_ts", "persist_ts", "price", "size", "venue_side", "source", "schema_version", "quality"];
const CANDLE_COLS = ["instrument_id", "interval", "open_ts", "o", "h", "l", "c", "base_vol", "quote_vol", "final", "exch_ts", "recv_ts", "persist_ts", "source", "schema_version", "quality"];
const TICKER_COLS = ["instrument_id", "exch_ts", "recv_ts", "persist_ts", "last", "bid", "ask", "bid_sz", "ask_sz", "mark", "index_px", "funding_rate",
  "next_funding_ts", "open_interest", "oi_unit", "source", "schema_version", "quality"];
const BOOK_COLS = ["instrument_id", "exch_ts", "recv_ts", "persist_ts", "seq", "levels", "bids_json", "asks_json", "source", "schema_version", "quality"];
function pick(o, cols) { const r = {}; for (const c of cols) r[c] = o[c] === undefined ? null : o[c]; return r; }

module.exports = { Store, DEFAULT_RETENTION_MS, MIGRATIONS };
