"use strict";
/* Decision pipeline + paper execution (paper-v2). PAPER ONLY: no code path here (or anywhere in server/) can place an
 * order. Accounting conventions: server/accounting.js (valuation-v1).
 *
 * At each final 15m bar close: evidence snapshot -> each analyst policy -> ledger "decision" (deterministic id, so a
 * retry or restart cannot trigger twice) -> for OPEN intents the independent risk gate -> ledger status -> paper fill.
 * Every state change is ONE database transaction that writes: the financial fact (paper_fills / paper_funding), the
 * position + cash projection, the ledger row(s) and the outbox event(s) the UI streams. Either all of it exists or none.
 *
 * Financial facts:
 *   entry fill : ask (long) / bid (short) at decision x (1 + side * slippage); taker fee booked to cash immediately
 *   funding    : one posting per (position, settlement) = -side * rate * qty * mark at settlement; unique key
 *   exit fill  : stop    -> the first tape trade at/through the stop; fills at the WORSE of stop and that trade
 *                target  -> the first tape trade at/through the target; fills at target, taker, minus slippage
 *                time    -> at time_exit_ts, at a FRESH bid/ask (never a stale quote), minus slippage
 * Data gaps (predeclared policy, decision D-016): a position is never deleted or re-priced because data is missing.
 *   While a trade-feed gap overlaps an open position it is flagged gap_affected ("path unresolved": a stop or target may
 *   have traded unseen). Management continues on the resumed tape; an exit still fills only at an OBSERVED price.
 *   All fills, fees and funding stay in the account. The outcome is excluded from path-dependent research metrics
 *   (evaluable = 0) and counted in the "uncertain" totals; it is never dropped from the portfolio.
 * Kill switch (persisted per analyst): new setups are rejected by the risk gate; there are no pending orders; open
 * positions keep being managed by their stop / target / time exit.
 * Single writer: one engine instance owns a database at a time (meta.engine_owner heartbeat). */

const crypto = require("node:crypto");
const { buildLive, EVIDENCE_VERSION, BAR } = require("./evidence");
const { decide: decidePolicy, ANALYSTS, RULES } = require("./policies");
const risk = require("./risk");
const acct = require("./accounting");
const DAY = 86400000, ENGINE_VERSION = "paper-v2", LOCK_STALE_MS = 30000;

class EngineLocked extends Error {}

class PaperEngine {
  constructor({ store, ledger, collector, health, now = Date.now, log = () => {}, config = risk.RISK_DEFAULTS, buildSnapshot = null, decide = decidePolicy,
                instruments = null, instanceId = crypto.randomUUID(), environment = "FORWARD" }) {
    Object.assign(this, { store, ledger, collector, health, now, log, config, decide, instanceId });
    this.buildSnapshot = buildSnapshot || ((id, close, dec) => buildLive({ store, collector, health, instrumentId: id, barCloseTs: close, decisionTs: dec }));
    this.instrumentIds = instruments || (() => Object.values(collector.idOf));
    this.db = store.db; this.lastDecided = {}; this.stats = { last_tick_ts: null, last_decision_ts: null, last_bar_close_ts: null, decisions: 0, last_decision_lag_ms: null };
    this.identity = store.identity(environment);
    if (this.identity.environment !== environment) throw new Error(`database environment is ${this.identity.environment}, engine was started as ${environment}`);
    this.acquireLock();
    this.ensurePortfolios();
    this.event({ key: `engine_start:${this.instanceId}`, type: "ENGINE_START", payload: { engine: ENGINE_VERSION, environment: this.identity.environment } });
  }

  // ------------------------------------------------------------------ single writer
  acquireLock() {
    const cur = JSON.parse(this.store.metaGet("engine_owner") || "null"), t = this.now();
    if (cur && cur.instance_id !== this.instanceId && t - cur.heartbeat_ts < LOCK_STALE_MS)
      throw new EngineLocked(`another engine instance (${String(cur.instance_id).slice(0, 8)}) is writing this database`);
    this.store.metaSet("engine_owner", JSON.stringify({ instance_id: this.instanceId, heartbeat_ts: t }));
  }
  heartbeat() {
    const cur = JSON.parse(this.store.metaGet("engine_owner") || "null");
    if (cur && cur.instance_id !== this.instanceId) throw new EngineLocked("engine ownership was taken by another instance; this instance stops writing");
    this.store.metaSet("engine_owner", JSON.stringify({ instance_id: this.instanceId, heartbeat_ts: this.now() }));
  }
  releaseLock() { const cur = JSON.parse(this.store.metaGet("engine_owner") || "null"); if (cur && cur.instance_id === this.instanceId) this.store.metaSet("engine_owner", "null"); }

  // ------------------------------------------------------------------ outbox
  /** Durable activity event. event_key is unique: a repeated write is ignored (idempotent). */
  event({ key, type, ts, analyst = null, instrument_id = null, position_id = null, decision_id = null, payload = {} }) {
    const t = this.now();
    this.db.prepare("INSERT OR IGNORE INTO paper_events (event_key, ts, recorded_ts, type, analyst, instrument_id, position_id, decision_id, payload) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(key, ts === undefined ? t : ts, t, type, analyst, instrument_id, position_id, decision_id, JSON.stringify(payload));
  }

  // ------------------------------------------------------------------ portfolio state (persisted)
  ensurePortfolios() {
    const t = this.now(), day = Math.floor(t / DAY) * DAY;
    const ins = this.db.prepare("INSERT OR IGNORE INTO paper_portfolios (analyst, equity, peak_equity, day_start_ts, day_start_equity, kill_switch, updated_ts) VALUES (?,?,?,?,?,0,?)");
    for (const a of ANALYSTS) ins.run(a, this.config.equity0, this.config.equity0, day, this.config.equity0, t);
  }
  /** Exchange MARK price with its own timestamp (never the last trade). */
  markOf(id) {
    const t = this.collector.latestTicker[id] || this.store.latestTicker(id);
    if (!t || t.mark === null || t.mark === undefined) return null;
    const p = Number(t.mark); return p > 0 ? { price: p, ts: t.recv_ts } : null;
  }
  positions(analyst, state = "OPEN") { return this.db.prepare("SELECT * FROM paper_positions WHERE analyst=? AND state=? ORDER BY opened_ts").all(analyst, state); }
  fills(positionId) { return this.db.prepare("SELECT * FROM paper_fills WHERE position_id=? ORDER BY ts, fill_id").all(positionId); }
  fundingOf(positionId) { return this.db.prepare("SELECT COALESCE(SUM(amount),0) AS a FROM paper_funding WHERE position_id=?").get(positionId).a; }
  /** Risk-gate view. equity = CASH BALANCE (fees and funding already booked); the gate adds unrealised at mark. */
  portfolio(analyst) {
    const p = this.db.prepare("SELECT * FROM paper_portfolios WHERE analyst=?").get(analyst);
    const pos = this.positions(analyst).map(x => { const m = this.markOf(x.instrument_id); return { instrument_id: x.instrument_id, side: x.side, qty: Number(x.qty), entry: x.entry, stop: x.stop, mark: m ? m.price : x.entry }; });
    return { analyst, equity: p.equity, peak_equity: p.peak_equity, day: { start_ts: p.day_start_ts, start_equity: p.day_start_equity }, positions: pos, kill_switch: !!p.kill_switch };
  }
  addCash(analyst, amount) { this.db.prepare("UPDATE paper_portfolios SET equity = equity + ?, updated_ts=? WHERE analyst=?").run(amount, this.now(), analyst); }
  /** Cash re-derived from the financial facts; must equal the stored balance. */
  derivedCash(analyst) {
    let cash = this.config.equity0;
    for (const p of this.db.prepare("SELECT position_id, side, instrument_id FROM paper_positions WHERE analyst=?").all(analyst)) {
      const pos = acct.positionFromFills(p.side, this.fills(p.position_id), this.store.instrument(p.instrument_id));
      cash += pos.realized_gross - pos.entry_fees - pos.exit_fees + this.fundingOf(p.position_id);
    }
    return cash;
  }
  reconcile() {
    const out = [];
    for (const a of ANALYSTS) {
      const stored = this.db.prepare("SELECT equity FROM paper_portfolios WHERE analyst=?").get(a).equity, derived = this.derivedCash(a), ok = Math.abs(stored - derived) < 1e-6;
      if (!ok) this.event({ key: `recon:${a}:${stored.toFixed(6)}:${derived.toFixed(6)}`, type: "RECONCILIATION_FAILURE", analyst: a, payload: { stored_cash: stored, cash_from_fills_and_funding: derived } });
      out.push({ analyst: a, ok, stored_cash: stored, derived_cash: derived });
    }
    return out;
  }
  /** Daily accounting rolls at 00:00 UTC; peak equity tracks MARK equity (cash + unrealised). */
  rollDay() {
    const t = this.now(), day = Math.floor(t / DAY) * DAY;
    for (const a of ANALYSTS) {
      const p = this.portfolio(a), eq = p.equity + risk.unrealised(p);
      if (p.day.start_ts < day) this.db.prepare("UPDATE paper_portfolios SET day_start_ts=?, day_start_equity=?, updated_ts=? WHERE analyst=?").run(day, eq, t, a);
      if (eq > p.peak_equity) this.db.prepare("UPDATE paper_portfolios SET peak_equity=? WHERE analyst=?").run(eq, a);
    }
  }
  setKillSwitch(analyst, on) {
    const list = analyst === "all" ? ANALYSTS : [analyst], t = this.now();
    this.store.tx(() => { for (const a of list) {
      this.db.prepare("UPDATE paper_portfolios SET kill_switch=?, updated_ts=? WHERE analyst=?").run(on ? 1 : 0, t, a);
      this.event({ key: `kill:${a}:${t}`, type: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", analyst: a, payload: { effect: "new setups rejected; open positions keep their exits" } });
    } });
    this.store.feedEvent("paper", on ? "kill_switch_on" : "kill_switch_off", list.join(","));
  }

  // ------------------------------------------------------------------ scheduling
  /** Called every few seconds. Decides once per bar close, after the bar is final (or 60 s after the close). */
  tick() {
    const t = this.now(), close = Math.floor(t / BAR) * BAR;
    this.heartbeat(); this.stats.last_tick_ts = t;
    this.rollDay();
    for (const id of this.instrumentIds()) {
      if (this.lastDecided[id] === undefined) { this.lastDecided[id] = close; continue; }   // never decide on bars that closed before start
      if (close <= this.lastDecided[id] || t < close + 3000) continue;
      const finalTs = this.store.lastFinalCandleTs(id, "15m");
      if (finalTs !== null && finalTs + BAR >= close || t > close + 60000) {
        this.lastDecided[id] = close; this.onBarClose(id, close, t);
        Object.assign(this.stats, { last_decision_ts: t, last_bar_close_ts: close, last_decision_lag_ms: t - close }); this.stats.decisions++;
      }
    }
    this.manage();
  }

  onBarClose(id, close, decisionTs) {
    const snap = this.buildSnapshot(id, close, decisionTs);
    this.db.prepare("INSERT OR IGNORE INTO evidence_snapshots (hash, instrument_id, bar_close_ts, created_ts, json) VALUES (?,?,?,?,?)")
      .run(snap.hash, id, close, this.now(), JSON.stringify(snap));
    const results = [];
    for (const a of ANALYSTS) {
      try { results.push(this.store.tx(() => this.decideOne(a, id, close, snap))); }
      catch (e) { this.store.feedEvent(`paper:${a}`, "decision_failed", e.message); this.log(`decision ${a} ${id}: ${e.message}`); results.push({ analyst: a, error: e.message }); }
    }
    return { snapshot: snap, results };
  }

  /** One analyst, one bar. Runs inside a single transaction (see onBarClose). */
  decideOne(analyst, id, close, snap) {
    const R = RULES[analyst];
    const decisionId = `decision:${R.version}:${id}:${close}`;
    if (this.ledger.get(decisionId)) return { analyst, decisionId, duplicate: true };   // already decided this bar: never trigger twice
    const open = this.positions(analyst).some(p => p.instrument_id === id);
    const last = this.db.prepare("SELECT exit_ts FROM paper_positions WHERE analyst=? AND instrument_id=? AND state='CLOSED' ORDER BY exit_ts DESC LIMIT 1").get(analyst, id);
    const ctx = { position_open: open, cooldown_until: last ? Math.floor(last.exit_ts / BAR) * BAR + (R.cooldownBars + 1) * BAR : null };
    const d = this.decide(analyst, snap, ctx);
    const versions = { policy: d.version, evidence: EVIDENCE_VERSION, risk: "risk-v1", engine: ENGINE_VERSION, valuation: acct.VALUATION_VERSION };
    const env = this.identity.environment, base = { analyst, instrument_id: id, decision_id: decisionId };
    this.ledger.append({ entry_id: decisionId, kind: "decision", data_cutoff_ts: snap.data_cutoff_ts === null || snap.data_cutoff_ts === undefined ? undefined : Math.min(snap.data_cutoff_ts, this.now()),
      versions, payload: { analyst, intent: d.intent, code: d.code, why: d.why, setup: d.setup, instrument_id: id, bar_close_ts: close, evidence_hash: snap.hash,
        context: ctx, execution_mode: "PAPER", environment: env, probability: null } });
    const isOpen = d.intent === "OPEN_LONG" || d.intent === "OPEN_SHORT";
    this.event({ key: `decision:${decisionId}`, type: isOpen ? "SETUP_CANDIDATE" : "DECISION_ABSTAIN", ts: close, ...base,
      payload: { intent: d.intent, code: d.code, why: d.why, setup: d.setup, bar_close_ts: close, evidence_hash: snap.hash, policy: d.version } });
    if (!isOpen) return { analyst, decisionId, intent: d.intent, code: d.code };
    const instrument = this.store.instrument(id);
    const g = risk.evaluate({ analyst, setup: { intent: d.intent, stop: d.setup.stop }, snapshot: snap, portfolio: this.portfolio(analyst), instrument, config: this.config });
    this.ledger.append({ entry_id: `risk:${decisionId}`, kind: "status", ref_id: decisionId, versions,
      payload: { state: g.approved ? "RISK_APPROVED" : "RISK_REJECTED", reasons: g.reasons, size: g.size } });
    this.event({ key: `risk:${decisionId}`, type: g.approved ? "RISK_APPROVED" : "RISK_REJECTED", ...base, payload: { reasons: g.reasons, checks: g.checks, size: g.size } });
    if (!g.approved) return { analyst, decisionId, intent: d.intent, code: "RISK_REJECTED", reasons: g.reasons };

    const side = d.intent === "OPEN_LONG" ? 1 : -1, fill = g.entry_reference * (1 + side * this.config.slipFrac);
    acct.baseUnits(g.size.qty_str, instrument);                                           // rejects unsupported contract types before any write
    const qty = Number(g.size.qty_str), fee = qty * fill * this.config.taker, t = this.now(), positionId = `pos:${decisionId}`;
    const tk = this.collector.latestTicker[id];
    this.db.prepare(`INSERT INTO paper_positions (position_id, decision_id, analyst, instrument_id, side, qty, entry, stop, target, time_exit_ts, opened_ts, entry_fee,
        funding, last_trade_ts, last_trade_id, next_funding_ts, state, evidence_hash, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,?,'OPEN',?,?)`)
      .run(positionId, decisionId, analyst, id, side, g.size.qty_str, fill, d.setup.stop, d.setup.target, d.setup.time_exit_ts, t, fee, t,
        tk && tk.next_funding_ts ? tk.next_funding_ts : null, snap.hash, d.version);
    const model = `${this.config.slipFrac * 1e4} bps vs ${side > 0 ? "ask" : "bid"} at decision; taker fee ${this.config.taker}`;
    this.db.prepare("INSERT INTO paper_fills (fill_id, position_id, analyst, instrument_id, ts, recorded_ts, kind, side, qty, price, fee, reason, model) VALUES (?,?,?,?,?,?,'ENTRY',?,?,?,?,?,?)")
      .run(`fill:entry:${positionId}`, positionId, analyst, id, t, t, side, g.size.qty_str, fill, fee, "entry", model);
    this.addCash(analyst, -fee);                                                          // the entry fee is paid now, not at close
    this.ledger.append({ entry_id: `open:${decisionId}`, kind: "status", ref_id: decisionId, versions,
      payload: { state: "POSITION_OPENED", fill, qty: g.size.qty_str, entry_fee: fee, stop: d.setup.stop, target: d.setup.target, time_exit_ts: d.setup.time_exit_ts,
        slippage_model: model, fee_model: `taker ${this.config.taker}` } });
    this.event({ key: `fill:entry:${positionId}`, type: "FILL", ts: t, ...base, position_id: positionId,
      payload: { kind: "ENTRY", side, qty: g.size.qty_str, price: fill, fee, reference_price: g.entry_reference, model, stop: d.setup.stop, target: d.setup.target } });
    return { analyst, decisionId, intent: d.intent, code: "OPENED", qty: g.size.qty_str, fill };
  }

  // ------------------------------------------------------------------ position management
  manage() {
    for (const p of this.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN'").all()) {
      try { this.store.tx(() => this.manageOne(p)); }
      catch (e) { this.store.feedEvent(p.position_id, "manage_failed", e.message); this.log(`manage ${p.position_id}: ${e.message}`); }
    }
  }
  feedHealthy(id) { return !this.health || typeof this.health.isHealthy !== "function" || this.health.isHealthy(`${id}|ticker`); }

  manageOne(p) {
    const t = this.now(), slip = this.config.slipFrac, base = { analyst: p.analyst, instrument_id: p.instrument_id, position_id: p.position_id, decision_id: p.decision_id };
    // (1) data completeness: flag the position while a gap or outage overlaps it (it stays open and fully accounted)
    if (!p.gap_affected) {
      const cov = this.store.coverage(p.instrument_id, "trade", p.opened_ts, t), unhealthy = !this.feedHealthy(p.instrument_id);
      if (cov.gaps.length || unhealthy) {
        const why = unhealthy ? "feed not healthy while the position is open" : `trade-feed gap (${cov.gaps[0].reason}) while the position is open`;
        this.db.prepare("UPDATE paper_positions SET gap_affected=1, note=? WHERE position_id=?").run(why + ": exit path unresolved; outcome excluded from path-dependent metrics", p.position_id);
        this.event({ key: `gap:${p.position_id}`, type: "DATA_GAP", ...base, payload: { why, gaps: cov.gaps.slice(0, 5), policy: "position kept; exits only at observed prices; outcome not evaluable" } });
        p.gap_affected = 1;
      }
    }
    // (2) funding settlements passed while open: one posting per settlement (unique key => never twice)
    const ins = this.store.instrument(p.instrument_id), ivMs = (ins && ins.fund_interval_h ? ins.fund_interval_h : 8) * 3600000;
    let nf = p.next_funding_ts;
    while (nf && nf <= t && nf > p.opened_ts) {
      const r = this.db.prepare("SELECT funding_rate, mark, last FROM tickers WHERE instrument_id=? AND exch_ts < ? AND funding_rate IS NOT NULL ORDER BY exch_ts DESC LIMIT 1").get(p.instrument_id, nf);
      const px = r ? Number(r.mark !== null && r.mark !== undefined ? r.mark : r.last) : NaN, amt = r ? acct.fundingCashflow(p.side, Number(p.qty), Number(r.funding_rate), px) : null;
      const id = `funding:${p.position_id}:${nf}`;
      if (amt === null) this.event({ key: id + ":unknown", type: "FUNDING_UNKNOWN", ts: nf, ...base, payload: { settlement_ts: nf, why: "no funding rate observed before the settlement; nothing booked" } });
      else if (this.db.prepare("INSERT OR IGNORE INTO paper_funding (posting_id, position_id, analyst, settlement_ts, recorded_ts, rate, mark, qty, amount, note) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, p.position_id, p.analyst, nf, t, String(r.funding_rate), px, p.qty, amt, r.mark === null ? "mark missing: last price used" : null).changes) {
        this.addCash(p.analyst, amt);
        this.event({ key: id, type: "FUNDING", ts: nf, ...base, payload: { settlement_ts: nf, rate: Number(r.funding_rate), mark: px, qty: p.qty, amount: amt } });
      }
      nf += ivMs;
    }
    const funding = this.fundingOf(p.position_id);
    if (nf !== p.next_funding_ts || funding !== p.funding) this.db.prepare("UPDATE paper_positions SET funding=?, next_funding_ts=? WHERE position_id=?").run(funding, nf, p.position_id);
    // (3) walk the trade tape in exchange order
    const trades = this.db.prepare(`SELECT trade_id, exch_ts, price FROM trades WHERE instrument_id=? AND (exch_ts > ? OR (exch_ts = ? AND trade_id > ?))
        ORDER BY exch_ts, trade_id LIMIT 5000`).all(p.instrument_id, p.last_trade_ts, p.last_trade_ts, p.last_trade_id || "");
    let cursor = { ts: p.last_trade_ts, id: p.last_trade_id };
    for (const tr of trades) {
      const px = Number(tr.price);
      if (tr.exch_ts > p.time_exit_ts) break;
      const stopHit = p.side > 0 ? px <= p.stop : px >= p.stop, tgtHit = p.side > 0 ? px >= p.target : px <= p.target;
      if (stopHit) return this.close(p, (p.side > 0 ? Math.min(px, p.stop) : Math.max(px, p.stop)) * (1 - p.side * slip), tr.exch_ts, "stop", funding, { trigger_trade: tr.trade_id, trigger_price: px });
      if (tgtHit) return this.close(p, p.target * (1 - p.side * slip), tr.exch_ts, "target", funding, { trigger_trade: tr.trade_id, trigger_price: px });
      cursor = { ts: tr.exch_ts, id: tr.trade_id };
    }
    if (cursor.ts !== p.last_trade_ts || cursor.id !== p.last_trade_id)
      this.db.prepare("UPDATE paper_positions SET last_trade_ts=?, last_trade_id=? WHERE position_id=?").run(cursor.ts, cursor.id, p.position_id);
    // (4) time exit needs a fresh quote and a healthy feed
    if (t >= p.time_exit_ts) {
      const tk = this.collector.latestTicker[p.instrument_id] || this.store.latestTicker(p.instrument_id);
      const fresh = tk && t - tk.recv_ts <= 10000 && this.feedHealthy(p.instrument_id);
      const px = tk ? Number(p.side > 0 ? tk.bid : tk.ask) : NaN;
      if (fresh && Number.isFinite(px) && px > 0) return this.close(p, px * (1 - p.side * slip), t, "time_exit", funding, { quote: px });
      this.store.feedEvent(p.position_id, "time_exit_waiting_for_fresh_price", tk ? `ticker age ${t - tk.recv_ts} ms` : "no ticker");
    }
  }

  close(p, exitPrice, exitTs, reason, funding, extra = {}) {
    const qty = Number(p.qty), exitFee = qty * exitPrice * this.config.taker, t = this.now();
    const gross = p.side * (exitPrice - p.entry) * qty, pnl = gross - p.entry_fee - exitFee + funding;
    const cov = this.store.coverage(p.instrument_id, "trade", p.opened_ts, exitTs);
    const unhealthyNow = !this.feedHealthy(p.instrument_id);   // an ongoing outage has no gap row yet (written on reconnect)
    const gapped = !!p.gap_affected || cov.gaps.length > 0 || unhealthyNow, evaluable = gapped ? 0 : 1;
    const note = !gapped ? null : unhealthyNow ? "feed not healthy at exit: exit may differ from reality" : "trade-feed gap while open: exit may differ from reality";
    const base = { analyst: p.analyst, instrument_id: p.instrument_id, position_id: p.position_id, decision_id: p.decision_id };
    this.db.prepare("INSERT INTO paper_fills (fill_id, position_id, analyst, instrument_id, ts, recorded_ts, kind, side, qty, price, fee, reason, model) VALUES (?,?,?,?,?,?,'EXIT',?,?,?,?,?,?)")
      .run(`fill:exit:${p.position_id}`, p.position_id, p.analyst, p.instrument_id, exitTs, t, p.side, p.qty, exitPrice, exitFee, reason, `${this.config.slipFrac * 1e4} bps slippage; taker fee ${this.config.taker}`);
    this.db.prepare(`UPDATE paper_positions SET state='CLOSED', exit_price=?, exit_ts=?, exit_reason=?, exit_fee=?, pnl=?, funding=?, evaluable=?, gap_affected=?, note=? WHERE position_id=?`)
      .run(exitPrice, exitTs, reason, exitFee, pnl, funding, evaluable, gapped ? 1 : 0, note, p.position_id);
    this.addCash(p.analyst, gross - exitFee);                  // entry fee and funding were booked when they occurred
    const versions = { engine: ENGINE_VERSION, valuation: acct.VALUATION_VERSION };
    this.ledger.append({ entry_id: `close:${p.decision_id}`, kind: "status", ref_id: p.decision_id, versions, payload: { state: "POSITION_CLOSED", exit_price: exitPrice, exit_ts: exitTs, reason } });
    const riskPerUnit = Math.abs(p.entry - p.stop), R = riskPerUnit > 0 ? (p.side * (exitPrice - p.entry)) / riskPerUnit : null;
    this.ledger.append({ entry_id: `outcome:${p.decision_id}`, kind: "outcome", ref_id: p.decision_id, versions,
      payload: { result: pnl > 0 ? "WIN" : "LOSS", evaluable: !!evaluable, pnl_usdt: pnl, gross_usdt: gross, fees_usdt: p.entry_fee + exitFee, funding_usdt: funding,
        r_multiple_gross: R, exit_reason: reason, coverage: cov.reasons } });
    this.event({ key: `fill:exit:${p.position_id}`, type: "FILL", ts: exitTs, ...base, payload: { kind: "EXIT", side: p.side, qty: p.qty, price: exitPrice, fee: exitFee, reason, ...extra } });
    this.event({ key: `closed:${p.position_id}`, type: "POSITION_CLOSED", ts: exitTs, ...base,
      payload: { reason, gross_usdt: gross, fees_usdt: p.entry_fee + exitFee, funding_usdt: funding, net_usdt: pnl, evaluable: !!evaluable, note } });
    return { closed: true, reason, pnl };
  }

  /** Per-analyst summary. Accounting covers EVERY position; "evaluable" metrics exclude gap-affected outcomes and say so. */
  summary() {
    return ANALYSTS.map(a => {
      const p = this.portfolio(a), closed = this.positions(a, "CLOSED"), open = this.positions(a);
      const ev = closed.filter(x => x.evaluable === 1), unc = closed.filter(x => x.evaluable !== 1), sum = L => L.reduce((s, x) => s + x.pnl, 0);
      return { analyst: a, policy: RULES[a].version, equity: p.equity, unrealised: risk.unrealised(p), peak_equity: p.peak_equity, kill_switch: p.kill_switch,
        open_positions: open.length, open_gap_affected: open.filter(x => x.gap_affected).length, closed: closed.length, evaluable_closed: ev.length, uncertain_closed: unc.length,
        uncertain_share: closed.length ? unc.length / closed.length : null, wins: ev.filter(x => x.pnl > 0).length,
        net_pnl_all_closed: sum(closed), net_pnl_evaluable: sum(ev), net_pnl_uncertain: sum(unc),
        performance_basis: "account figures include every position; win/expectancy metrics use the evaluable subset only",
        edge_status: "NO_DEMONSTRATED_EDGE", edge_note: "forward paper results are far too few to estimate an edge; see devdocs/verification.md" };
    });
  }
}

module.exports = { PaperEngine, EngineLocked, ENGINE_VERSION };
