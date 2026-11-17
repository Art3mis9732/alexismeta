"use strict";
/* Valuation recorder: writes one bounded sample per open position and per account per minute, so a P&L timeline and a maximum drawdown can be shown
 * with an honest statement of what was actually recorded. It reads the monitor's views (already computed with accounting.js) and writes ONLY
 * paper_valuation_samples and paper_equity_samples. It never writes the ledger, fills, positions or portfolios, never runs inside a decision
 * transaction, never back-fills, and a failure here is logged and ignored: it cannot affect trading or accounting.
 * Drawdown is peak-to-trough over the RECORDED mark-equity samples. Anything between two samples (and any time before recording started) is unknown. */
const MIN = 60000;

class ValuationRecorder {
  constructor({ store, monitor, now = Date.now, log = () => {} }) {
    Object.assign(this, { store, monitor, now, log, db: store.db });
    this.lastMinute = null; this.peak = {}; this.errors = 0; this.written = { positions: 0, accounts: 0 };
    this.st = {
      pos: this.db.prepare("INSERT OR IGNORE INTO paper_valuation_samples (position_id, ts, mark, gross_unrealized, est_close, net_if_closed, margin_allocated, roi_primary_pct, mark_status, book_status) VALUES (?,?,?,?,?,?,?,?,?,?)"),
      eq: this.db.prepare("INSERT OR IGNORE INTO paper_equity_samples (analyst, ts, cash, mark_equity, closeout_equity, open_positions, pricing, peak, drawdown_pct) VALUES (?,?,?,?,?,?,?,?,?)"),
      lastPeak: this.db.prepare("SELECT peak FROM paper_equity_samples WHERE analyst=? ORDER BY ts DESC LIMIT 1")
    };
  }
  /** Called often; records at most once per minute. Returns the number of rows written. */
  tick() {
    const t = this.now(), minute = Math.floor(t / MIN) * MIN;
    if (minute === this.lastMinute) return 0;
    let n = 0;
    try {
      const open = this.monitor.positions(), acc = this.monitor.accounts().accounts;
      for (const p of open) {
        const L = p.live; if (!L) continue;
        const roi = L.roi.find(r => r.primary);
        n += Number(this.st.pos.run(p.position_id, minute, L.prices.mark, L.gross_unrealized.value, L.prices.estimated_close, L.net_if_closed.whole_trade ? L.net_if_closed.whole_trade.net : null,
          L.margin.allocated_now, roi ? roi.value : null, L.prices.mark_status, L.prices.book_status).changes); this.written.positions++;
      }
      for (const a of acc) {
        if (a.mark_equity === null || a.mark_equity === undefined) continue;                        // never record an unavailable equity as a number
        if (this.peak[a.analyst] === undefined) { const r = this.st.lastPeak.get(a.analyst); this.peak[a.analyst] = r && r.peak !== null ? r.peak : a.mark_equity; }
        this.peak[a.analyst] = Math.max(this.peak[a.analyst], a.mark_equity);
        const dd = (a.mark_equity / this.peak[a.analyst] - 1) * 100;
        n += Number(this.st.eq.run(a.analyst, minute, a.cash_balance, a.mark_equity, a.closeout ? a.closeout.equity_estimate : null, a.counts.open, a.pricing ? a.pricing.completeness : null, this.peak[a.analyst], dd).changes); this.written.accounts++;
      }
      this.lastMinute = minute;
      if (n && this.monitor.invalidateDrawdown) this.monitor.invalidateDrawdown();
    } catch (e) { this.errors++; this.log("valuation recorder: " + e.message); }
    return n;
  }
}

/** Coverage of a sample series: first/last, count, gaps longer than gapMs (default 2.5 minutes), and the share of expected minutes that exist. */
function coverageOf(rows, { gapMs = 150000 } = {}) {
  if (!rows.length) return { count: 0, first_ts: null, last_ts: null, gaps: [], expected_minutes: 0, coverage: null };
  const gaps = []; for (let i = 1; i < rows.length; i++) if (rows[i].ts - rows[i - 1].ts > gapMs) gaps.push({ after: rows[i - 1].ts, before: rows[i].ts, ms: rows[i].ts - rows[i - 1].ts });
  const expected = Math.round((rows[rows.length - 1].ts - rows[0].ts) / MIN) + 1;
  return { count: rows.length, first_ts: rows[0].ts, last_ts: rows[rows.length - 1].ts, gaps, expected_minutes: expected, coverage: rows.length / expected };
}
module.exports = { ValuationRecorder, coverageOf };
