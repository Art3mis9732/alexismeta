"use strict";
/* Bitget Classic v2 PUBLIC market data (no keys): REST client + WebSocket supervisor.
 * Decision D-004: Classic v2 only (no UTA v3 mixing). There is NO order placement code in this module or anywhere
 * in server/ (real-money execution is absent by design). */

const BASE_URL = "https://api.bitget.com";
const WS_URL = "wss://ws.bitget.com/v2/ws/public";

const sleepReal = ms => new Promise(r => setTimeout(r, ms));

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^attempt)]. */
function backoffMs(attempt, { baseMs = 1000, capMs = 30000, random = Math.random } = {}) {
  return Math.floor(random() * Math.min(capMs, baseMs * Math.pow(2, attempt)));
}

class BitgetRest {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = BASE_URL, minIntervalMs = 120, maxAttempts = 5, timeoutMs = 10000,
                sleep = sleepReal, now = Date.now, random = Math.random } = {}) {
    Object.assign(this, { fetchImpl, baseUrl, minIntervalMs, maxAttempts, timeoutMs, sleep, now, random });
    this._next = 0;   // earliest time the next request may start (simple spacing limiter, ~8 req/s)
    this.stats = { requests: 0, retries: 0, errors: 0 };
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = this.baseUrl + path + (qs ? "?" + qs : "");
    let lastErr = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const wait = this._next - this.now();
      if (wait > 0) await this.sleep(wait);
      this._next = this.now() + this.minIntervalMs;
      this.stats.requests++;
      let res, body;
      const sent = this.now();
      try {
        const ac = typeof AbortController === "function" ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), this.timeoutMs) : null;
        try { res = await this.fetchImpl(url, ac ? { signal: ac.signal } : {}); } finally { if (timer) clearTimeout(timer); }
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
        body = await res.json();
      } catch (e) {
        lastErr = e;
        if (e.retry === false) break;
        this.stats.retries++;
        await this.sleep(backoffMs(attempt, { random: this.random }));
        continue;
      }
      if (String(body.code) !== "00000") { this.stats.errors++; throw new Error(`bitget ${path}: code=${body.code} msg=${String(body.msg).slice(0, 200)}`); }
      return { body, sentTs: sent, recvTs: this.now() };
    }
    this.stats.errors++;
    throw new Error(`bitget ${path}: retries exhausted (${lastErr && lastErr.message})`);
  }

  /** Clock offset = serverTime - midpoint(send, receive). Positive = exchange clock ahead of ours. */
  async clockOffset() {
    const { body, sentTs, recvTs } = await this.get("/api/v2/public/time");
    const server = Number(body.data.serverTime);
    return { offset_ms: Math.round(server - (sentTs + recvTs) / 2), rtt_ms: recvTs - sentTs };
  }
  contracts(productType) { return this.get("/api/v2/mix/market/contracts", { productType }); }
  candles(symbol, productType, granularity, { limit = 1000, startTime, endTime } = {}) {
    const p = { symbol, productType, granularity, limit: String(limit) };
    if (startTime !== undefined) p.startTime = String(startTime);
    if (endTime !== undefined) p.endTime = String(endTime);
    return this.get("/api/v2/mix/market/candles", p);
  }
}

/* One supervised public connection. Responsibilities:
 *   - exactly one socket at a time (a new connect closes the old one first)
 *   - (re)subscribe all channels after every open
 *   - text "ping" every pingMs; reconnect if NO frame at all (data or pong) for silenceMs
 *   - reconnect with exponential backoff + full jitter; attempt counter resets after a stable period
 *   - parse errors and server error events are reported, never thrown */
class WsSupervisor {
  constructor({ url = WS_URL, WebSocketImpl = globalThis.WebSocket, subscriptions = [], onMessage = () => {}, onState = () => {},
                onFrame = () => {}, onError = () => {}, pingMs = 25000, silenceMs = 60000, stableMs = 60000, now = Date.now,
                random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { url, WebSocketImpl, subscriptions, onMessage, onState, onFrame, onError, pingMs, silenceMs, stableMs, now, random, setTimer, clearTimer });
    this.ws = null; this.attempt = 0; this.stopped = true; this.lastFrame = 0; this.openedAt = 0;
    this.timers = { retry: null, ping: null, watchdog: null };
    this.stats = { connects: 0, opens: 0, closes: 0, parse_errors: 0, server_errors: 0 };
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    for (const k of Object.keys(this.timers)) { this.clearTimer(this.timers[k]); this.timers[k] = null; }
    this._drop();
    this.onState("closed");
  }

  _drop() {
    if (!this.ws) return;
    const w = this.ws; this.ws = null;
    w.onopen = w.onmessage = w.onclose = w.onerror = null;
    try { w.close(); } catch (e) { /* already closed */ }
  }

  connect() {
    if (this.stopped) return;
    this.clearTimer(this.timers.retry); this.timers.retry = null;
    this._drop();
    this.stats.connects++;
    this.onState("connecting");
    let w;
    try { w = new this.WebSocketImpl(this.url); } catch (e) { this.onError(e); return this._scheduleRetry(); }
    this.ws = w;
    w.onopen = () => {
      if (this.ws !== w) return;
      this.stats.opens++; this.openedAt = this.now(); this.lastFrame = this.now();
      this.onState("open");
      // Bitget accepts many args per subscribe; send in chunks to stay well under per-message limits.
      for (let i = 0; i < this.subscriptions.length; i += 20) w.send(JSON.stringify({ op: "subscribe", args: this.subscriptions.slice(i, i + 20) }));
      this.clearTimer(this.timers.ping);
      const tick = () => {
        if (this.ws !== w) return;
        try { w.send("ping"); } catch (e) { /* close handler will run */ }
        if (this.now() - this.lastFrame > this.silenceMs) { this.onError(new Error("silence: no frames for " + this.silenceMs + " ms")); return this._lost(w); }
        if (this.attempt && this.now() - this.openedAt > this.stableMs) this.attempt = 0;
        this.timers.ping = this.setTimer(tick, this.pingMs);
      };
      this.timers.ping = this.setTimer(tick, this.pingMs);
    };
    w.onmessage = ev => {
      if (this.ws !== w) return;
      const recv = this.now(); this.lastFrame = recv;
      const s = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.onFrame(recv);
      if (s === "pong") return;
      let m; try { m = JSON.parse(s); } catch (e) { this.stats.parse_errors++; return this.onMessage(null, recv, s); }
      if (m && m.event === "error") { this.stats.server_errors++; this.onError(new Error(`server error ${m.code}: ${m.msg}`)); }
      this.onMessage(m, recv, s);
    };
    w.onclose = () => { if (this.ws === w) this._lost(w); };
    w.onerror = () => { if (this.ws === w) this._lost(w); };
  }

  _lost(w) {
    if (this.ws !== w) return;
    this.stats.closes++;
    this.clearTimer(this.timers.ping); this.timers.ping = null;
    this._drop();
    this.onState("closed");
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this.stopped || this.timers.retry) return;
    const d = Math.max(250, backoffMs(this.attempt++, { random: this.random }));
    this.timers.retry = this.setTimer(() => { this.timers.retry = null; this.connect(); }, d);
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
}

module.exports = { BitgetRest, WsSupervisor, backoffMs, BASE_URL, WS_URL };
