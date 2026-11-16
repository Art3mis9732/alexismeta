"use strict";
/* Per-feed freshness. Only DATA messages refresh a feed; heartbeats (pong) never do (fixes defect A-01).
 *
 *   DISCONNECTED  socket not open
 *   RECOVERING    socket open but this feed has not delivered data since the (re)connect, within its grace period
 *   STALE         last data older than the feed's stale threshold (or no data after the grace period)
 *   HEALTHY       otherwise
 *
 * Thresholds are per feed and reflect expected cadence. Initial values are engineering defaults to be checked
 * against measured gaps (see /api/health `max_gap_ms`). */

const DEFAULT_STALE_MS = { ticker: 10000, trade: 60000, candle1m: 20000, candle15m: 20000, books: 10000 };
const STATES = { HEALTHY: "HEALTHY", STALE: "STALE", DISCONNECTED: "DISCONNECTED", RECOVERING: "RECOVERING" };

class Health {
  constructor({ now = Date.now, staleMs = DEFAULT_STALE_MS, graceMs = 15000 } = {}) {
    this.now = now; this.staleMs = staleMs; this.graceMs = graceMs;
    this.socket = { state: "closed", since: now(), reconnects: 0, last_frame_ts: null };
    this.feeds = new Map();
    this.clock = { offset_ms: null, rtt_ms: null, checked_ts: null };
  }

  register(feed, kind) {
    if (!this.feeds.has(feed)) this.feeds.set(feed, { feed, kind, last_exch_ts: null, last_recv_ts: null, since_connect: false, max_gap_ms: 0, count: 0 });
  }

  onSocket(state) {
    const t = this.now();
    if (state === "open" && this.socket.state !== "open") {
      if (this.socket.everOpen) this.socket.reconnects++;
      this.socket.everOpen = true;
      for (const f of this.feeds.values()) f.since_connect = false;
    }
    this.socket.state = state; this.socket.since = t;
  }

  /** Any frame incl. pong: tracked separately, used only for connection-level liveness. */
  onFrame() { this.socket.last_frame_ts = this.now(); }

  onData(feed, exchTs) {
    const f = this.feeds.get(feed); if (!f) return;
    const t = this.now();
    if (f.last_recv_ts !== null && f.since_connect) f.max_gap_ms = Math.max(f.max_gap_ms, t - f.last_recv_ts);
    f.last_recv_ts = t; f.last_exch_ts = exchTs; f.since_connect = true; f.count++;
  }

  setClock(offsetMs, rttMs) { this.clock = { offset_ms: offsetMs, rtt_ms: rttMs, checked_ts: this.now() }; }

  stateOf(f) {
    const t = this.now();
    if (this.socket.state !== "open") return STATES.DISCONNECTED;
    const thr = this.staleMs[f.kind] || 30000;
    if (!f.since_connect) return t - this.socket.since <= this.graceMs ? STATES.RECOVERING : STATES.STALE;
    return t - f.last_recv_ts > thr ? STATES.STALE : STATES.HEALTHY;
  }

  isHealthy(feed) { const f = this.feeds.get(feed); return !!f && this.stateOf(f) === STATES.HEALTHY; }

  snapshot() {
    const t = this.now();
    return {
      socket: { state: this.socket.state, since: this.socket.since, reconnects: this.socket.reconnects,
        last_frame_age_ms: this.socket.last_frame_ts === null ? null : t - this.socket.last_frame_ts },
      clock: this.clock,
      feeds: [...this.feeds.values()].map(f => ({ feed: f.feed, kind: f.kind, state: this.stateOf(f),
        stale_after_ms: this.staleMs[f.kind] || 30000,
        receipt_age_ms: f.last_recv_ts === null ? null : t - f.last_recv_ts,
        observation_age_ms: f.last_exch_ts === null ? null : t - f.last_exch_ts,
        last_exch_ts: f.last_exch_ts, last_recv_ts: f.last_recv_ts, max_gap_ms: f.max_gap_ms, messages: f.count }))
    };
  }
}

module.exports = { Health, STATES, DEFAULT_STALE_MS };
