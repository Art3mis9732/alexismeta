"use strict";
/* Deterministic test doubles: a manual clock/timer scheduler and a scriptable fake WebSocket. */

function makeClock(start = Date.UTC(2026, 10, 16, 8, 0, 0)) {
  let now = start, seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size
  };
  return clock;
}

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; this.closed = false; FakeWS.instances.push(this); }
  send(s) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(s); }
  close() { this.readyState = 3; this.closed = true; }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  msg(o) { this.onmessage && this.onmessage({ data: typeof o === "string" ? o : JSON.stringify(o) }); }
  drop() { this.readyState = 3; this.onclose && this.onclose(); }
  subs() { return this.sent.filter(s => s !== "ping").map(s => JSON.parse(s)); }
}
FakeWS.instances = [];
FakeWS.reset = () => { FakeWS.instances = []; };

module.exports = { makeClock, FakeWS };
