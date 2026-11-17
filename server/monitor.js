"use strict";
/* Backend-owned views for the live paper monitor (monitor-v1). READ ONLY: nothing here changes financial state.
 * The ledger, fills and funding postings are authoritative; valuations are computed here with server/accounting.js
 * from the worker's own mark price and order book. The browser renders these views; it never recomputes P&L.
 *
 * Streaming (server-sent events, /api/stream?after=<cursor>):
 *   hello      first frame: instance, database identity, current cursor
 *   activity   one frame per durable outbox event, id = sequence number, `prev` = the previous sequence (gap detection)
 *   valuation  coalesced once a second (latest only, never queued); carries engine/feed status, so it doubles as a heartbeat
 *   resnapshot the client's cursor is unusable (different database, too old, ahead of us): reload the REST snapshot
 * Durable events are read from the database by cursor, so a slow or reconnecting client can never lose one; valuation
 * frames are skipped for a client whose socket is backed up, and a client that stays backed up is disconnected. */

const acct = require("./accounting");
const { coverageOf } = require("./valuation_recorder");
const risk = require("./risk");
const { ANALYSTS, RULES, explain, registry } = require("./policies");
const { BAR, EVIDENCE_VERSION } = require("./evidence");

const MONITOR_SCHEMA = "monitor-v1", MAX_CLIENTS = 20, BACKLOG_SKIP = 64 * 1024, BACKLOG_DROP = 1024 * 1024;

class Monitor {
  constructor({ store, collector, health, getEngine, runtime, config = risk.RISK_DEFAULTS, now = Date.now }) {
    Object.assign(this, { store, collector, health, getEngine, runtime, config, now });
    this.db = store.db; this.clients = new Set(); this.timer = null; this.streamStats = { clients_total: 0, dropped_slow: 0, valuation_frames_skipped: 0 };
  }

  // ------------------------------------------------------------------ envelope / identity
  lastSeq() { return this.db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM paper_events").get().s; }
  minSeq() { return this.db.prepare("SELECT COALESCE(MIN(seq),0) AS s FROM paper_events").get().s; }
  env(extra = {}) {
    const id = this.runtime.database;
    return { schema_version: MONITOR_SCHEMA, environment: id.environment, mode: "PAPER", execution: "SIMULATED (no orders are sent anywhere)", db_id: id.db_id,
      instance_id: this.runtime.instance_id, calc_ts: this.now(), cursor: this.lastSeq(), valuation_method: acct.VALUATION_VERSION, ...extra };
  }
  engineState() {
    const e = this.getEngine();
    if (!e) return { state: this.runtime.engine_error ? "LOCKED_OR_FAILED" : "NOT_STARTED", detail: this.runtime.engine_error || null };
    const t = this.now(), age = e.stats.last_tick_ts === null ? null : t - e.stats.last_tick_ts;
    return { state: age !== null && age < 20000 ? "RUNNING" : "STALLED", last_tick_age_ms: age, ...e.stats, next_bar_close_ts: (Math.floor(t / BAR) + 1) * BAR };
  }

  // ------------------------------------------------------------------ valuation
  quotes(id) {
    const t = this.collector.latestTicker[id] || null, n = v => v === null || v === undefined ? null : Number(v);
    if (!t) return null;
    return { last: n(t.last), bid: n(t.bid), ask: n(t.ask), mark: n(t.mark), index: n(t.index_px), exchange_ts: t.exch_ts, received_ts: t.recv_ts, age_ms: this.now() - t.recv_ts,
      note: "last, bid/ask, mark and index are distinct prices from the same ticker message" };
  }
  bookOf(id) {
    const b = this.collector.books ? this.collector.books[id] : null;
    if (!b) return null;
    const top = b.top(400);
    return { state: b.state, ts: b.recvTs, bids: top.bids, asks: top.asks };
  }
  invalidateDrawdown() { this._dd = {}; }                                       // called by the recorder after it writes, so the shown maximum never lags a new sample
  /** Maximum drawdown over the RECORDED mark-equity samples (peak-to-trough). Unknown before recording started and between samples; coverage is part of the answer. Cached 30 s. */
  drawdownRecorded(analyst) {
    this._dd = this._dd || {}; const t = this.now(), c = this._dd[analyst];
    if (c && t - c.at < 30000) return c.v;
    const a = this.db.prepare("SELECT MIN(drawdown_pct) AS m, COUNT(*) AS n, MIN(ts) AS a, MAX(ts) AS b FROM paper_equity_samples WHERE analyst=?").get(analyst);
    const g = a.n > 1 ? this.db.prepare("SELECT MAX(ts - prev) AS g FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM paper_equity_samples WHERE analyst=?)").get(analyst).g : null;
    const v = { max_pct: a.n ? Math.min(0, a.m) : null, samples: a.n, first_ts: a.a, last_ts: a.b, largest_gap_ms: g,
      basis: a.n ? "peak-to-trough over mark-equity samples recorded once a minute since the first sample; time before recording and between samples is unknown, so intra-gap peaks and troughs are not included" : "no equity samples recorded yet" };
    this._dd[analyst] = { at: t, v }; return v;
  }
  /** The decision that produced a position (immutable ledger row, memoised): signal code and reason for the history view. */
  decisionOf(decisionId) {
    this._dec = this._dec || new Map(); if (this._dec.has(decisionId)) return this._dec.get(decisionId);
    const r = this.db.prepare("SELECT payload FROM ledger_entries WHERE entry_id=?").get(decisionId); let out = null;
    if (r) { try { const z = JSON.parse(r.payload); out = { intent: z.intent, code: z.code, why: z.why, bar_close_ts: z.bar_close_ts }; } catch (e) { out = null; } }
    if (out || this._dec.size < 5000) this._dec.set(decisionId, out); return out;
  }
  /** Entry sizing recorded in the ledger risk status at the moment the position was approved (immutable, so memoised). Null if not found. */
  recordedSizing(decisionId) {
    this._rec = this._rec || new Map();
    if (this._rec.has(decisionId)) return this._rec.get(decisionId);
    const r = this.db.prepare("SELECT payload FROM ledger_entries WHERE entry_id=?").get("risk:" + decisionId); let out = null;
    if (r) { try { const z = JSON.parse(r.payload).size; if (z && z.risk_usdt > 0) out = { margin: z.margin, notional: z.notional, risk_usdt: z.risk_usdt }; } catch (e) { out = null; } }
    if (out || this._rec.size < 5000) this._rec.set(decisionId, out);
    return out;
  }
  positionView(p) {
    const ins = this.store.instrument(p.instrument_id), fills = this.db.prepare("SELECT * FROM paper_fills WHERE position_id=? ORDER BY ts, fill_id").all(p.position_id);
    const pos = acct.positionFromFills(p.side, fills, ins), lev = this.config.exchangeLev, now = this.now();
    const funding = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS a FROM paper_funding WHERE position_id=?").get(p.position_id).a;
    const q = this.quotes(p.instrument_id), book = this.bookOf(p.instrument_id);
    const v = p.state === "OPEN" ? acct.valuePosition({ pos, mark: q && q.mark ? { price: q.mark, ts: q.received_ts } : null, book, now, feeRate: this.config.taker, leverage: lev, settledFunding: funding }) : null;
    const tk = this.collector.latestTicker ? this.collector.latestTicker[p.instrument_id] : null;
    const fundingInfo = tk && tk.funding_rate !== null && tk.funding_rate !== undefined && Number.isFinite(Number(tk.funding_rate)) ? { rate: Number(tk.funding_rate), next_settlement_ts: tk.next_funding_ts || null } : null;
    const live = p.state === "OPEN" && v ? acct.liveMetrics({ pos, valuation: v, leverage: lev, recorded: this.recordedSizing(p.decision_id), funding: fundingInfo }) : null;
    const notional = pos.remaining_qty * (pos.avg_entry || 0), stopDist = Math.max(0, p.side * ((pos.avg_entry || p.entry) - p.stop));
    return {
      position_id: p.position_id, decision_id: p.decision_id, trade_id: p.position_id, analyst: p.analyst, analyst_name: RULES[p.analyst] ? RULES[p.analyst].name : p.analyst,
      strategy_version: p.policy_version || (p.decision_id || "").split(":")[1] || null, instrument_id: p.instrument_id, venue: ins ? ins.venue : null, symbol: ins ? ins.native_id : null,
      inst_class: ins ? ins.inst_class : null, side: p.side, direction: p.side > 0 ? "LONG" : "SHORT",
      state: p.state === "CLOSED" ? "CLOSED" : pos.state, data_state: p.gap_affected ? "GAP_AFFECTED" : "COMPLETE", path_resolved: !p.gap_affected, note: p.note || null,
      opened_ts: p.opened_ts, duration_ms: (p.exit_ts || now) - p.opened_ts, entry_fill_price: pos.avg_entry, entry_qty: pos.entry_qty, remaining_qty: pos.remaining_qty, qty_unit: ins ? ins.base : null,
      entry_notional: pos.entry_qty * (pos.avg_entry || 0), remaining_entry_notional: notional,
      margin: { model: "simulator", leverage_setting: lev, reserved: lev > 0 ? notional / lev : null },
      stop: p.stop, target: p.target, invalidation: p.stop, time_exit_ts: p.time_exit_ts,
      fees_paid: pos.entry_fees + pos.exit_fees, entry_fees: pos.entry_fees, exit_fees: pos.exit_fees, funding_settled: funding, realized_gross: pos.realized_gross,
      open_risk_usdt: p.state === "OPEN" ? stopDist * pos.remaining_qty + notional * (2 * this.config.taker + this.config.slipFrac) : 0,
      distance_to_invalidation_pct: v && v.mark.price ? p.side * (v.mark.price - p.stop) / v.mark.price * 100 : null,
      quotes: q, valuation: v, live, evidence_hash: p.evidence_hash || null, fills: fills.length,
      closed: p.state === "CLOSED" ? { exit_price: p.exit_price, exit_ts: p.exit_ts, reason: p.exit_reason, net_usdt: p.pnl, evaluable: p.evaluable === 1,
        gross_usdt: pos.realized_gross, initial_margin: lev > 0 ? pos.entry_qty * (pos.avg_entry || 0) / lev : null, margin_setting_leverage: lev, holding_ms: p.exit_ts - p.opened_ts,
        net_return_on_initial_margin_pct: lev > 0 && pos.entry_qty * (pos.avg_entry || 0) > 0 ? p.pnl / (pos.entry_qty * pos.avg_entry / lev) * 100 : null,
        roi_basis: "booked net result (after all fees and settled funding) / initial margin = entry fill notional / margin setting", signal: this.decisionOf(p.decision_id) } : null
    };
  }
  positions() { return this.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN' ORDER BY opened_ts").all().map(p => this.positionView(p)); }

  // ------------------------------------------------------------------ accounts (independent portfolios; never one fictitious account)
  accounts() {
    const lev = this.config.exchangeLev, out = [];
    for (const a of ANALYSTS) {
      const pf = this.db.prepare("SELECT * FROM paper_portfolios WHERE analyst=?").get(a); if (!pf) continue;
      const rows = this.db.prepare("SELECT * FROM paper_positions WHERE analyst=?").all(a), views = rows.map(p => this.positionView(p));
      const parts = rows.map((p, i) => ({ pos: acct.positionFromFills(p.side, this.db.prepare("SELECT * FROM paper_fills WHERE position_id=?").all(p.position_id), this.store.instrument(p.instrument_id)),
        funding: views[i].funding_settled, u_mark: views[i].valuation ? views[i].valuation.u_mark : null }));
      const av = acct.accountView({ start: this.config.equity0, positions: parts, leverage: lev });
      const extras = acct.accountExtras({ av, items: parts.map((pt, i) => ({ pos: pt.pos, v: views[i].valuation })), start: this.config.equity0 });
      const open = views.filter(v => v.state !== "CLOSED"), closed = views.filter(v => v.state === "CLOSED"), unc = closed.filter(v => !v.closed.evaluable), ev = closed.filter(v => v.closed.evaluable);
      const sum = L => L.reduce((s, v) => s + v.closed.net_usdt, 0);
      const stale = open.some(v => v.valuation && (v.valuation.mark.status !== "OK"));
      out.push({ account_id: `paper:${a}`, analyst: a, analyst_name: RULES[a].name, strategy_version: RULES[a].version, kill_switch: !!pf.kill_switch, ...av, ...extras,
        cash_balance_stored: pf.equity, cash_reconciles: Math.abs(pf.equity - av.cash_balance) < 1e-6, valuation_status: !open.length ? "NO_OPEN_POSITIONS" : av.mark_equity === null ? "UNAVAILABLE" : stale ? "STALE" : "OK",
        peak_mark_equity: pf.peak_equity, drawdown_pct: av.mark_equity !== null && pf.peak_equity > 0 ? Math.min(0, av.mark_equity / pf.peak_equity - 1) * 100 : null,
        portfolio_return_pct_of_starting_capital: av.mark_equity !== null ? (av.mark_equity / this.config.equity0 - 1) * 100 : null,
        day: { start_ts: pf.day_start_ts, start_equity: pf.day_start_equity, boundary: "00:00 UTC" },
        counts: { open: open.length, open_gap_affected: open.filter(v => v.data_state !== "COMPLETE").length, closed: closed.length, closed_evaluable: ev.length, closed_uncertain: unc.length,
          uncertain_share: closed.length ? unc.length / closed.length : null },
        unresolved_exposure_usdt: open.filter(v => v.data_state !== "COMPLETE").reduce((s, v) => s + v.remaining_entry_notional, 0),
        results: { net_all_closed: sum(closed), net_evaluable: sum(ev), net_uncertain: sum(unc), wins_evaluable: ev.filter(v => v.closed.net_usdt > 0).length,
          basis: "cash/equity cover EVERY position; win counts use the evaluable subset; uncertain trades are shown, never dropped" },
        drawdown_recorded: this.drawdownRecorded(a), edge_status: "NO_DEMONSTRATED_EDGE" });
    }
    return { accounts: out, structure: `${out.length} independent paper portfolios of ${this.config.equity0} USDT each (total starting capital ${out.length * this.config.equity0} USDT). They are compared side by side and never summed into one account; there is no shared allocator.` };
  }

  // ------------------------------------------------------------------ history / detail / activity
  closed(limit = 50) { return this.db.prepare("SELECT * FROM paper_positions WHERE state='CLOSED' ORDER BY exit_ts DESC LIMIT ?").all(limit).map(p => this.positionView(p)); }
  eventRow(r, prev) { return { seq: r.seq, prev, key: r.event_key, type: r.type, ts: r.ts, recorded_ts: r.recorded_ts, analyst: r.analyst, instrument_id: r.instrument_id, position_id: r.position_id, decision_id: r.decision_id, payload: JSON.parse(r.payload) }; }
  activity({ after = null, before = null, limit = 100, type = null, analyst = null, instrument = null } = {}) {
    const w = [], a = [];
    if (after !== null) { w.push("seq > ?"); a.push(after); } if (before !== null) { w.push("seq < ?"); a.push(before); }
    if (type) { w.push("type = ?"); a.push(type); } if (analyst) { w.push("analyst = ?"); a.push(analyst); } if (instrument) { w.push("instrument_id = ?"); a.push(instrument); }
    const rows = this.db.prepare(`SELECT * FROM paper_events ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY seq ${after !== null ? "ASC" : "DESC"} LIMIT ?`).all(...a, limit);
    return rows.map(r => this.eventRow(r, null));
  }
  detail(positionId) {
    const p = this.db.prepare("SELECT * FROM paper_positions WHERE position_id=?").get(positionId);
    if (!p) return null;
    const dec = this.db.prepare("SELECT * FROM ledger_entries WHERE entry_id=?").get(p.decision_id), payload = dec ? JSON.parse(dec.payload) : null;
    const snapRow = payload ? this.db.prepare("SELECT json FROM evidence_snapshots WHERE hash=?").get(payload.evidence_hash) : null;
    const end = p.exit_ts || this.now(), from = p.opened_ts - 30 * 60000;
    const candles = this.db.prepare("SELECT open_ts, o, h, l, c, base_vol, final FROM candles WHERE instrument_id=? AND interval='1m' AND open_ts >= ? AND open_ts <= ? ORDER BY open_ts").all(p.instrument_id, from, end);
    const missing = []; for (let i = 1; i < candles.length; i++) if (candles[i].open_ts - candles[i - 1].open_ts !== 60000) missing.push({ after: candles[i - 1].open_ts, before: candles[i].open_ts });
    const tl = this.db.prepare("SELECT ts, mark, gross_unrealized, est_close, net_if_closed, margin_allocated, roi_primary_pct, mark_status, book_status FROM paper_valuation_samples WHERE position_id=? ORDER BY ts").all(positionId);
    const since = this.db.prepare("SELECT MIN(ts) AS t FROM paper_valuation_samples").get().t;
    const timeline = { samples: tl, coverage: coverageOf(tl), recording_since_ts: since, basis: "valuations recorded by the monitor once a minute while the position was open; never reconstructed from prices; gaps stay empty",
      note: tl.length ? null : since === null ? "no valuation has been recorded yet by this worker" : "recording began after this position opened, or the position closed before recording began" };
    return { position: this.positionView(p), timeline,
      decision: dec ? { entry_id: dec.entry_id, created_ts: dec.created_ts, data_cutoff_ts: dec.data_cutoff_ts, code_rev: dec.code_rev, versions: JSON.parse(dec.versions), hash: dec.hash, ...payload } : null,
      evidence: snapRow ? JSON.parse(snapRow.json) : null,
      predicates: snapRow ? explain(p.analyst, JSON.parse(snapRow.json)) : null,
      ledger_history: this.db.prepare("SELECT seq, entry_id, kind, created_ts, payload, hash FROM ledger_entries WHERE entry_id=? OR ref_id=? ORDER BY seq").all(p.decision_id, p.decision_id).map(r => ({ ...r, payload: JSON.parse(r.payload) })),
      fills: this.db.prepare("SELECT * FROM paper_fills WHERE position_id=? ORDER BY ts, fill_id").all(positionId),
      funding: this.db.prepare("SELECT * FROM paper_funding WHERE position_id=? ORDER BY settlement_ts").all(positionId),
      stop_target_changes: { permitted: false, note: "v1 never moves a stop or target after entry; a changed setup would be a new decision" },
      data_gaps: this.db.prepare("SELECT kind, from_ts, to_ts, reason FROM coverage_gaps WHERE instrument_id=? AND to_ts > ? AND from_ts < ? ORDER BY from_ts").all(p.instrument_id, p.opened_ts, end),
      chart: { interval: "1m", from_ts: from, to_ts: end, candles, missing_ranges: missing, note: "stored worker candles only; missing ranges are gaps and are not interpolated" },
      events: this.db.prepare("SELECT * FROM paper_events WHERE position_id=? OR decision_id=? ORDER BY seq").all(positionId, p.decision_id).map(r => this.eventRow(r, null)) };
  }

  /** Why is there (no) trade? Latest decision per analyst and coin with predicate-level reasons, plus scheduler facts. */
  diagnostics() {
    const out = [], ids = Object.values(this.collector.idOf || {});
    for (const id of ids) {
      const s = this.db.prepare("SELECT json FROM evidence_snapshots WHERE instrument_id=? ORDER BY bar_close_ts DESC LIMIT 1").get(id), snap = s ? JSON.parse(s.json) : null;
      const n15 = this.db.prepare("SELECT COUNT(*) AS n FROM candles WHERE instrument_id=? AND interval='15m' AND final=1").get(id).n;
      for (const a of ANALYSTS) {
        const d = this.db.prepare("SELECT created_ts, payload FROM ledger_entries WHERE kind='decision' AND entry_id LIKE ? ORDER BY seq DESC LIMIT 1").get(`decision:${RULES[a].version}:${id}:%`);
        const p = d ? JSON.parse(d.payload) : null;
        out.push({ analyst: a, instrument_id: id, last_decision: p ? { intent: p.intent, code: p.code, why: p.why, bar_close_ts: p.bar_close_ts, decided_ts: d.created_ts, evidence_hash: p.evidence_hash, setup: p.setup } : null,
          predicates: snap && p && snap.hash === p.evidence_hash ? explain(a, snap) : null });
      }
      out.push({ instrument_id: id, warmup: { final_15m_bars: n15, required: 300, satisfied: n15 >= 300, note: "trend needs 50 complete hours; ATR percentile needs 100 bars" } });
    }
    const dec = this.db.prepare("SELECT json_extract(payload,'$.intent') AS intent, json_extract(payload,'$.code') AS code, COUNT(*) AS n FROM ledger_entries WHERE kind='decision' GROUP BY 1,2 ORDER BY n DESC").all();
    return { engine: this.engineState(), decisions_by_outcome: dec, rows: out,
      impossible_rule_check: "each v1 rule is satisfiable (fixture scenarios S1-S7 open positions); abstention is the expected result on most bars" };
  }

  registry() {
    return { strategies: registry(), models: [], model_note: "No statistical or machine-learning model is registered. The three analysts are deterministic rule sets.",
      legacy: [{ id: "legacy-logistic-score", type: "STATISTICAL (logistic regression, legacy cron job)", state: "DISPLAY_ONLY", calibration: "NOT_CALIBRATED", note: "shown on the Buy/Sell tab as an uncalibrated score; not used by any analyst" }],
      evidence_version: EVIDENCE_VERSION, valuation_version: acct.VALUATION_VERSION };
  }
  jobs() { return { training_backend: "UNAVAILABLE", jobs: [], note: "No training or experiment job runner exists yet. Nothing is queued, running or completed; no progress or metrics are shown because none exist." }; }

  snapshot() { return this.env({ engine: this.engineState(), ...this.accounts(), positions: this.positions(), recent_closed: this.closed(20), recent_activity: this.activity({ limit: 60 }) }); }

  // ------------------------------------------------------------------ SSE
  attachStream(req, res, after) {
    if (this.clients.size >= MAX_CLIENTS) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "too many stream clients" })); }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
    const last = this.lastSeq(), min = this.minSeq(), c = { res, cursor: last, lastVal: 0 };
    const send = (event, data, id) => res.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    c.send = send;
    send("hello", this.env({ stream: "sse", retry_hint_ms: 2000 }));
    res.write("retry: 2000\n\n");
    if (after === null) c.cursor = last;
    else if (after > last || (min > 0 && after < min - 1)) { send("resnapshot", { reason: after > last ? "cursor is ahead of this database (different instance or database)" : "cursor is older than the retained events", cursor: last }); c.cursor = last; }
    else c.cursor = after;
    this.clients.add(c); this.streamStats.clients_total++;
    req.on("close", () => { this.clients.delete(c); if (!this.clients.size && this.timer) { clearInterval(this.timer); this.timer = null; } });
    if (!this.timer) this.timer = setInterval(() => this.pump(), 500);
    this.pump();
  }
  pump() {
    const t = this.now(); let val = null;
    for (const c of [...this.clients]) {
      try {
        if (c.res.writableLength > BACKLOG_DROP) { this.streamStats.dropped_slow++; c.res.destroy(); this.clients.delete(c); continue; }
        const rows = this.db.prepare("SELECT * FROM paper_events WHERE seq > ? ORDER BY seq LIMIT 200").all(c.cursor);
        let prev = c.cursor;
        for (const r of rows) { c.send("activity", this.eventRow(r, prev), r.seq); prev = r.seq; }
        c.cursor = prev;
        if (t - c.lastVal >= 1000) {
          if (c.res.writableLength > BACKLOG_SKIP) { this.streamStats.valuation_frames_skipped++; continue; }
          if (!val) val = this.env({ engine: this.engineState(), feeds: this.feedSummary(), positions: this.positions(), accounts: this.accounts().accounts });
          c.send("valuation", val); c.lastVal = t;
        }
      } catch (e) { try { c.res.destroy(); } catch (e2) { /* gone */ } this.clients.delete(c); }
    }
  }
  feedSummary() {
    const h = this.health.snapshot(), bad = h.feeds.filter(f => f.state !== "HEALTHY");
    return { socket: h.socket.state, healthy: h.feeds.length - bad.length, total: h.feeds.length, not_healthy: bad.map(f => `${f.feed} ${f.state}`).slice(0, 8) };
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const c of this.clients) { try { c.res.end(); } catch (e) { /* gone */ } } this.clients.clear(); }
}

module.exports = { Monitor, MONITOR_SCHEMA };
