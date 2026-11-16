"use strict";
/* Order book state for Bitget WS `books` (snapshot, then incremental updates).
 *
 * Integrity rules (decision D-007):
 *   - An update must chain: update.pseq === seq of the last applied message. This rule was OBSERVED on the live
 *     feed (2026-11-16); the official classic docs describe snapshot+update but do not state it.
 *   - seq <= last applied seq  -> duplicate / late message, ignored (not applied, not fatal).
 *   - Negative size, non-positive price, unsorted snapshot levels, or best bid >= best ask after applying
 *     -> book INVALID. Dependent features must not use it. The caller resubscribes; only a fresh snapshot
 *     restores VALID.
 * Size "0" in an update deletes the level. */

const STATES = { EMPTY: "EMPTY", VALID: "VALID", INVALID: "INVALID" };

class OrderBook {
  constructor(instrumentId) {
    this.instrumentId = instrumentId;
    this.bids = new Map(); this.asks = new Map();
    this.state = STATES.EMPTY; this.reason = "awaiting_snapshot";
    this.seq = null; this.exchTs = null; this.recvTs = null;
    this.stats = { snapshots: 0, updates: 0, duplicates: 0, invalidations: 0 };
  }

  invalidate(reason) {
    this.state = STATES.INVALID; this.reason = reason; this.stats.invalidations++;
    return { ok: false, reason, invalid: true };
  }

  _levels(map, levels, isSnapshot) {
    for (const [p, s] of levels) {
      const P = Number(p), S = Number(s);
      if (!(P > 0)) return "nonpositive_price";
      if (S < 0) return "negative_size";
      if (S === 0) { if (!isSnapshot) map.delete(p); }
      else map.set(p, s);
    }
    return null;
  }

  applySnapshot(ev) {
    for (const [side, desc] of [["bids", true], ["asks", false]]) {
      const L = ev[side];
      for (let i = 1; i < L.length; i++) {
        const a = Number(L[i - 1][0]), b = Number(L[i][0]);
        if (desc ? !(a > b) : !(a < b)) { this.bids.clear(); this.asks.clear(); return this.invalidate("unsorted_snapshot_" + side); }
      }
    }
    this.bids = new Map(); this.asks = new Map();
    const bad = this._levels(this.bids, ev.bids, true) || this._levels(this.asks, ev.asks, true);
    if (bad) return this.invalidate(bad);
    this.seq = ev.seq; this.exchTs = ev.exch_ts; this.recvTs = ev.recv_ts; this.stats.snapshots++;
    if (this._crossed()) return this.invalidate("crossed");
    this.state = STATES.VALID; this.reason = null;
    return { ok: true };
  }

  applyUpdate(ev) {
    if (this.state !== STATES.VALID) return { ok: false, reason: "awaiting_snapshot", ignored: true };
    if (ev.seq <= this.seq) { this.stats.duplicates++; return { ok: false, reason: "duplicate_or_late", ignored: true }; }
    if (ev.pseq !== this.seq) return this.invalidate(`seq_gap(expected pseq ${this.seq}, got ${ev.pseq})`);
    const bad = this._levels(this.bids, ev.bids, false) || this._levels(this.asks, ev.asks, false);
    if (bad) return this.invalidate(bad);
    this.seq = ev.seq; this.exchTs = ev.exch_ts; this.recvTs = ev.recv_ts; this.stats.updates++;
    if (this._crossed()) return this.invalidate("crossed");
    return { ok: true };
  }

  apply(ev) { return ev.action === "snapshot" ? this.applySnapshot(ev) : this.applyUpdate(ev); }

  /** Called when the connection drops: whatever we hold may have missed updates. */
  reset(reason) { this.bids.clear(); this.asks.clear(); this.state = STATES.EMPTY; this.reason = reason || "awaiting_snapshot"; this.seq = null; }

  _best(map, desc) {
    let best = null;
    for (const p of map.keys()) { const v = Number(p); if (best === null || (desc ? v > best.v : v < best.v)) best = { p, v }; }
    return best;
  }
  _crossed() { const b = this._best(this.bids, true), a = this._best(this.asks, false); return !!(b && a && b.v >= a.v); }

  /** Top-n levels as [[price, size], ...] (exact strings). Empty arrays unless VALID. */
  top(n) {
    if (this.state !== STATES.VALID) return { bids: [], asks: [] };
    const sortSide = (m, desc) => [...m.entries()].sort((x, y) => desc ? Number(y[0]) - Number(x[0]) : Number(x[0]) - Number(y[0])).slice(0, n);
    return { bids: sortSide(this.bids, true), asks: sortSide(this.asks, false) };
  }

  summary() {
    const b = this._best(this.bids, true), a = this._best(this.asks, false);
    return { instrument_id: this.instrumentId, state: this.state, reason: this.reason, seq: this.seq, exch_ts: this.exchTs, recv_ts: this.recvTs,
      best_bid: this.state === STATES.VALID && b ? b.p : null, best_ask: this.state === STATES.VALID && a ? a.p : null,
      levels: { bids: this.bids.size, asks: this.asks.size }, stats: { ...this.stats } };
  }
}

module.exports = { OrderBook, STATES };
