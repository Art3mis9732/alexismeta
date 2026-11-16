"use strict";
/* Decision pipeline + paper execution. PAPER ONLY: no code path here (or anywhere in server/) can place an order.
 *
 * At each 15m bar close (once the bar is final): evidence snapshot -> each analyst policy -> ledger "decision"
 * (deterministic id, so a retry/restart cannot create a second trigger) -> for OPEN intents the independent risk gate
 * -> ledger "status" RISK_APPROVED/REJECTED -> paper fill -> ledger "status" POSITION_OPENED.
 * Positions are managed against the persisted TRADE TAPE in exchange order (exact sequence; no candle-touch guessing):
 *   stop     : triggered by the first trade at/through the stop; filled at the WORSE of stop and that trade price,
 *              minus slippage (stops are not guaranteed prices)
 *   target   : triggered by the first trade at/through the target; filled at target minus slippage (taker, conservative)
 *   time exit: at time_exit_ts, at the bid (long) / ask (short) from the ticker, minus slippage
 *   funding  : charged at each settlement while open, at the last funding rate observed before settlement
 *   a recorded trade-feed gap while the position was open -> outcome evaluable=0 (excluded from performance)
 * Close -> ledger "status" POSITION_CLOSED + "outcome" with the realised result. Originals are never edited.
 * Kill switch (persisted per analyst): new setups are rejected by the risk gate; there are no pending orders (entries
 * are immediate paper market fills); existing positions keep being managed by their stop/target/time exit. */

const { buildLive, EVIDENCE_VERSION, BAR } = require("./evidence");
const { decide: decidePolicy, ANALYSTS, RULES } = require("./policies");
const risk = require("./risk");
const DAY = 86400000;

class PaperEngine {
  constructor({ store, ledger, collector, health, now = Date.now, log = () => {}, config = risk.RISK_DEFAULTS,
                buildSnapshot = null, decide = decidePolicy, instruments = null }) {
    Object.assign(this, { store, ledger, collector, health, now, log, config, decide });
    this.buildSnapshot = buildSnapshot || ((id, close, dec) => buildLive({ store, collector, health, instrumentId: id, barCloseTs: close, decisionTs: dec }));
    this.instrumentIds = instruments || (() => Object.values(collector.idOf));
    this.db = store.db; this.lastDecided = {};
    this.ensurePortfolios();
  }

  // ------------------------------------------------------------------ portfolio state (persisted)
  ensurePortfolios() {
    const t = this.now(), day = Math.floor(t / DAY) * DAY;
    const ins = this.db.prepare("INSERT OR IGNORE INTO paper_portfolios (analyst, equity, peak_equity, day_start_ts, day_start_equity, kill_switch, updated_ts) VALUES (?,?,?,?,?,0,?)");
    for (const a of ANALYSTS) ins.run(a, this.config.equity0, this.config.equity0, day, this.config.equity0, t);
  }
  markOf(id) { const t = this.collector.latestTicker[id] || this.store.latestTicker(id); return t ? Number(t.last) : null; }
  positions(analyst, state = "OPEN") { return this.db.prepare("SELECT * FROM paper_positions WHERE analyst=? AND state=? ORDER BY opened_ts").all(analyst, state); }
  portfolio(analyst) {
    const p = this.db.prepare("SELECT * FROM paper_portfolios WHERE analyst=?").get(analyst);
    const pos = this.positions(analyst).map(x => ({ instrument_id: x.instrument_id, side: x.side, qty: Number(x.qty), entry: x.entry, stop: x.stop, mark: this.markOf(x.instrument_id) || x.entry }));
    return { analyst, equity: p.equity, peak_equity: p.peak_equity, day: { start_ts: p.day_start_ts, start_equity: p.day_start_equity }, positions: pos, kill_switch: !!p.kill_switch };
  }
  rollDay() {
    const t = this.now(), day = Math.floor(t / DAY) * DAY;
    for (const a of ANALYSTS) {
      const p = this.portfolio(a);
      if (p.day.start_ts < day) {
        const eq = p.equity + risk.unrealised(p);
        this.db.prepare("UPDATE paper_portfolios SET day_start_ts=?, day_start_equity=?, updated_ts=? WHERE analyst=?").run(day, eq, t, a);
      }
    }
  }
  setKillSwitch(analyst, on) {
    const list = analyst === "all" ? ANALYSTS : [analyst];
    for (const a of list) this.db.prepare("UPDATE paper_portfolios SET kill_switch=?, updated_ts=? WHERE analyst=?").run(on ? 1 : 0, this.now(), a);
    this.store.feedEvent("paper", on ? "kill_switch_on" : "kill_switch_off", list.join(","));
  }

  // ------------------------------------------------------------------ scheduling
  /** Called every few seconds. Decides once per bar close, after the bar is final (or 60 s after the close). */
  tick() {
    const t = this.now(), close = Math.floor(t / BAR) * BAR;
    this.rollDay();
    for (const id of this.instrumentIds()) {
      if (this.lastDecided[id] === undefined) { this.lastDecided[id] = close; continue; }   // never decide on bars that closed before start
      if (close <= this.lastDecided[id] || t < close + 3000) continue;
      const finalTs = this.store.lastFinalCandleTs(id, "15m");
      if (finalTs !== null && finalTs + BAR >= close || t > close + 60000) { this.lastDecided[id] = close; this.onBarClose(id, close, t); }
    }
    this.manage();
  }

  onBarClose(id, close, decisionTs) {
    const snap = this.buildSnapshot(id, close, decisionTs);
    this.db.prepare("INSERT OR IGNORE INTO evidence_snapshots (hash, instrument_id, bar_close_ts, created_ts, json) VALUES (?,?,?,?,?)")
      .run(snap.hash, id, close, this.now(), JSON.stringify(snap));
    const results = [];
    for (const a of ANALYSTS) {
      try { results.push(this.decideOne(a, id, close, snap)); }
      catch (e) { this.store.feedEvent(`paper:${a}`, "decision_failed", e.message); this.log(`decision ${a} ${id}: ${e.message}`); results.push({ analyst: a, error: e.message }); }
    }
    return { snapshot: snap, results };
  }

  decideOne(analyst, id, close, snap) {
    const R = RULES[analyst];
    const decisionId = `decision:${R.version}:${id}:${close}`;
    if (this.ledger.get(decisionId)) return { analyst, decisionId, duplicate: true };   // already decided this bar: never trigger twice
    const open = this.positions(analyst).some(p => p.instrument_id === id);
    const last = this.db.prepare("SELECT exit_ts FROM paper_positions WHERE analyst=? AND instrument_id=? AND state='CLOSED' ORDER BY exit_ts DESC LIMIT 1").get(analyst, id);
    const ctx = { position_open: open, cooldown_until: last ? Math.floor(last.exit_ts / BAR) * BAR + (R.cooldownBars + 1) * BAR : null };
    const d = this.decide(analyst, snap, ctx);
    const versions = { policy: d.version, evidence: EVIDENCE_VERSION, risk: "risk-v1", engine: "paper-v1" };
    const entry = this.ledger.append({ entry_id: decisionId, kind: "decision", data_cutoff_ts: snap.data_cutoff_ts === null ? undefined : Math.min(snap.data_cutoff_ts, this.now()),
      versions, payload: { analyst, intent: d.intent, code: d.code, why: d.why, setup: d.setup, instrument_id: id, bar_close_ts: close, evidence_hash: snap.hash,
        context: ctx, execution_mode: "PAPER", probability: null } });
    if (entry.duplicate) return { analyst, decisionId, intent: d.intent, duplicate: true };       // retry/restart: no second trigger
    if (d.intent !== "OPEN_LONG" && d.intent !== "OPEN_SHORT") return { analyst, decisionId, intent: d.intent, code: d.code };
    const instrument = this.store.instrument(id);
    const g = risk.evaluate({ analyst, setup: { intent: d.intent, stop: d.setup.stop }, snapshot: snap, portfolio: this.portfolio(analyst), instrument, config: this.config });
    this.ledger.append({ entry_id: `risk:${decisionId}`, kind: "status", ref_id: decisionId, versions,
      payload: { state: g.approved ? "RISK_APPROVED" : "RISK_REJECTED", reasons: g.reasons, size: g.size } });
    if (!g.approved) return { analyst, decisionId, intent: d.intent, code: "RISK_REJECTED", reasons: g.reasons };
    const side = d.intent === "OPEN_LONG" ? 1 : -1, fill = g.entry_reference * (1 + side * this.config.slipFrac);
    const qty = Number(g.size.qty_str), fee = qty * fill * this.config.taker, t = this.now();
    const tk = this.collector.latestTicker[id];
    this.db.prepare(`INSERT INTO paper_positions (position_id, decision_id, analyst, instrument_id, side, qty, entry, stop, target, time_exit_ts, opened_ts, entry_fee,
        funding, last_trade_ts, last_trade_id, next_funding_ts, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,?,'OPEN')`)
      .run(`pos:${decisionId}`, decisionId, analyst, id, side, g.size.qty_str, fill, d.setup.stop, d.setup.target, d.setup.time_exit_ts, t, fee, t,
        tk && tk.next_funding_ts ? tk.next_funding_ts : null);
    this.ledger.append({ entry_id: `open:${decisionId}`, kind: "status", ref_id: decisionId, versions,
      payload: { state: "POSITION_OPENED", fill, qty: g.size.qty_str, entry_fee: fee, stop: d.setup.stop, target: d.setup.target, time_exit_ts: d.setup.time_exit_ts,
        slippage_model: `${this.config.slipFrac * 1e4} bps vs ${side > 0 ? "ask" : "bid"} at decision`, fee_model: `taker ${this.config.taker}` } });
    return { analyst, decisionId, intent: d.intent, code: "OPENED", qty: g.size.qty_str, fill };
  }

  // ------------------------------------------------------------------ position management
  manage() {
    const open = this.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN'").all();
    for (const p of open) this.manageOne(p);
  }

  manageOne(p) {
    const t = this.now(), slip = this.config.slipFrac;
    // funding settlements passed while open
    const ins = this.store.instrument(p.instrument_id), ivMs = (ins && ins.fund_interval_h ? ins.fund_interval_h : 8) * 3600000;
    let nf = p.next_funding_ts, funding = p.funding;
    while (nf && nf <= t && nf > p.opened_ts) {
      const r = this.db.prepare("SELECT funding_rate, last FROM tickers WHERE instrument_id=? AND exch_ts < ? AND funding_rate IS NOT NULL ORDER BY exch_ts DESC LIMIT 1").get(p.instrument_id, nf);
      if (r) funding -= p.side * Number(r.funding_rate) * Number(p.qty) * Number(r.last);
      else this.store.feedEvent(p.position_id, "funding_rate_unknown", String(nf));
      nf += ivMs;
    }
    if (nf !== p.next_funding_ts) this.db.prepare("UPDATE paper_positions SET funding=?, next_funding_ts=? WHERE position_id=?").run(funding, nf, p.position_id);
    // walk the trade tape in exchange order
    const trades = this.db.prepare(`SELECT trade_id, exch_ts, price FROM trades WHERE instrument_id=? AND (exch_ts > ? OR (exch_ts = ? AND trade_id > ?))
        ORDER BY exch_ts, trade_id LIMIT 5000`).all(p.instrument_id, p.last_trade_ts, p.last_trade_ts, p.last_trade_id || "");
    let cursor = { ts: p.last_trade_ts, id: p.last_trade_id };
    for (const tr of trades) {
      const px = Number(tr.price);
      if (tr.exch_ts > p.time_exit_ts) break;
      const stopHit = p.side > 0 ? px <= p.stop : px >= p.stop, tgtHit = p.side > 0 ? px >= p.target : px <= p.target;
      if (stopHit) return this.close(p, (p.side > 0 ? Math.min(px, p.stop) : Math.max(px, p.stop)) * (1 - p.side * slip), tr.exch_ts, "stop", funding);
      if (tgtHit) return this.close(p, p.target * (1 - p.side * slip), tr.exch_ts, "target", funding);
      cursor = { ts: tr.exch_ts, id: tr.trade_id };
    }
    if (cursor.ts !== p.last_trade_ts || cursor.id !== p.last_trade_id)
      this.db.prepare("UPDATE paper_positions SET last_trade_ts=?, last_trade_id=? WHERE position_id=?").run(cursor.ts, cursor.id, p.position_id);
    if (t >= p.time_exit_ts) {
      const tk = this.collector.latestTicker[p.instrument_id] || this.store.latestTicker(p.instrument_id);
      const fresh = tk && t - tk.recv_ts <= 10000 && this.feedHealthy(p.instrument_id);
      const px = tk ? Number(p.side > 0 ? tk.bid : tk.ask) : NaN;
      if (fresh && Number.isFinite(px) && px > 0) return this.close(p, px * (1 - p.side * slip), t, "time_exit", funding);
      this.store.feedEvent(p.position_id, "time_exit_waiting_for_fresh_price", tk ? `ticker age ${t - tk.recv_ts} ms` : "no ticker");
    }
  }

  feedHealthy(id) { return !this.health || typeof this.health.isHealthy !== "function" || this.health.isHealthy(`${id}|ticker`); }

  close(p, exitPrice, exitTs, reason, funding) {
    const qty = Number(p.qty), exitFee = qty * exitPrice * this.config.taker;
    const gross = p.side * (exitPrice - p.entry) * qty, pnl = gross - p.entry_fee - exitFee + funding;
    const cov = this.store.coverage(p.instrument_id, "trade", p.opened_ts, exitTs);
    const unhealthyNow = !this.feedHealthy(p.instrument_id);   // an ongoing outage has no gap row yet (written on reconnect)
    const gapped = cov.gaps.length > 0 || unhealthyNow, evaluable = gapped ? 0 : 1;
    const riskPerUnit = Math.abs(p.entry - p.stop), R = riskPerUnit > 0 ? (p.side * (exitPrice - p.entry)) / riskPerUnit : null;
    this.db.prepare(`UPDATE paper_positions SET state='CLOSED', exit_price=?, exit_ts=?, exit_reason=?, exit_fee=?, pnl=?, funding=?, evaluable=?, note=? WHERE position_id=?`)
      .run(exitPrice, exitTs, reason, exitFee, pnl, funding, evaluable, gapped ? (unhealthyNow ? "feed not healthy at exit: exit may differ from reality" : "trade-feed gap while open: exit may differ from reality") : null, p.position_id);
    const pf = this.db.prepare("SELECT equity, peak_equity FROM paper_portfolios WHERE analyst=?").get(p.analyst);
    const eq = pf.equity + pnl;
    this.db.prepare("UPDATE paper_portfolios SET equity=?, peak_equity=?, updated_ts=? WHERE analyst=?").run(eq, Math.max(pf.peak_equity, eq), this.now(), p.analyst);
    const versions = { engine: "paper-v1" };
    this.ledger.append({ entry_id: `close:${p.decision_id}`, kind: "status", ref_id: p.decision_id, versions,
      payload: { state: "POSITION_CLOSED", exit_price: exitPrice, exit_ts: exitTs, reason } });
    this.ledger.append({ entry_id: `outcome:${p.decision_id}`, kind: "outcome", ref_id: p.decision_id, versions,
      payload: { result: pnl > 0 ? "WIN" : "LOSS", evaluable: !!evaluable, pnl_usdt: pnl, gross_usdt: gross, fees_usdt: p.entry_fee + exitFee, funding_usdt: funding,
        r_multiple_gross: R, exit_reason: reason, coverage: cov.reasons } });
    return { closed: true, reason, pnl };
  }

  summary() {
    return ANALYSTS.map(a => {
      const p = this.portfolio(a), closed = this.positions(a, "CLOSED");
      const ev = closed.filter(x => x.evaluable === 1);
      return { analyst: a, policy: RULES[a].version, equity: p.equity, unrealised: risk.unrealised(p), peak_equity: p.peak_equity, kill_switch: p.kill_switch,
        open_positions: p.positions.length, closed: closed.length, evaluable_closed: ev.length, wins: ev.filter(x => x.pnl > 0).length,
        net_pnl_evaluable: ev.reduce((s, x) => s + x.pnl, 0), edge_status: "NO_DEMONSTRATED_EDGE",
        edge_note: "forward paper results are far too few to estimate an edge; see devdocs/verification.md" };
    });
  }
}

module.exports = { PaperEngine };
