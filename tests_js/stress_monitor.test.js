"use strict";
/* Stress monitor integration tests: real Store (SQLite), fake collector/health, injected clock. SYNTHETIC inputs establish behaviour, not accuracy. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const { StressMonitor } = require("../server/stress_monitor");
const S = require("../server/stress");
const { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const MIN = 60000, ID = "bitget:perp:BTCUSDT", T0 = Date.UTC(2026, 10, 17, 12, 0, 0), SIG = 0.0004;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stress-")), "t.db");

function insertCandle(store, id, t, px, v = 10) {
  store.db.prepare(`INSERT OR REPLACE INTO candles (instrument_id, interval, open_ts, o, h, l, c, base_vol, quote_vol, final, exch_ts, recv_ts, persist_ts, source, schema_version, quality)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 'test', 1, '[]')`).run(id, t, String(px), String(px), String(px), String(px), String(v), t + MIN, t + MIN, t + MIN);
}
/** rig: clock t, 1500 historical 1m candles ending at T0, ticker/book/health fakes, monitor under test */
function rig({ env = "TEST", mode = "SHADOW", synthetic = null, file = ":memory:", nCandles = 1500, cfg = S.CONFIG, t0 = T0, price0 = 60000 } = {}) {
  let t = t0; const now = () => t, store = new Store(file, { now });
  store.coverage = () => ({ complete: true, reasons: [], gaps: [] });
  const r = rng(5); let px = price0;
  for (let i = nCandles; i >= 1; i--) { px *= Math.exp(SIG * gauss(r)); insertCandle(store, ID, t0 - i * MIN, px, 10 * Math.exp(0.3 * gauss(r))); }
  const health = { st: "HEALTHY", snapshot() { return { feeds: ["ticker", "books", "trade"].map(k => ({ feed: `${ID}|${k}`, kind: k, state: this.st })) }; } };
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: {}, books: { [ID]: { state: "VALID", top: () => ({ bids: [["59999.9", "30"]], asks: [["60000", "30"]] }) } } };
  const rg = { store, health, collector, now: () => t, set: v => { t = v; }, price: px, mon: null, mode, env, cfg, file, synthetic };
  const mk = () => new StressMonitor({ store, collector, health, now, config: cfg, mode, environment: env, synthetic });
  rg.mk = mk; rg.mon = mk();
  /** drive the clock in 5 s steps; fn(elapsedSec) gives the price (null = ticker disconnected: no new ticker, so it ages) */
  rg.run = (sec, fn = () => rg.price, mon = rg.mon) => {
    const start = t;
    for (let e = 5; e <= sec; e += 5) {
      t = start + e * 1000;
      if (t % MIN === 0) insertCandle(store, ID, t - MIN, rg.price, 10);
      const p = fn(e);
      if (p !== null) { rg.price = p; collector.latestTicker[ID] = { last: String(p), bid: String(p - 0.1), ask: String(p), bid_sz: "1", ask_sz: "1", recv_ts: t, exch_ts: t, open_interest: "1000", funding_rate: "0.0001", next_funding_ts: t + 3600000, mark: String(p) }; }
      mon.tick();
    }
  };
  return rg;
}
const inst = rg => rg.mon.snapshot().instruments.find(i => i.instrument_id === ID);
const trs = (rg, where = "") => rg.store.db.prepare("SELECT * FROM stress_transitions " + where + " ORDER BY id").all();
const alignedStart = T0;                                                                    // T0 is on a minute boundary, so candle inserts line up

test("calm market: severity NORMAL and known, no event, one summary sample per minute, state restorable", () => {
  const g = rig(); g.run(180);
  const i = inst(g);
  assert.equal(i.severity, "NORMAL"); assert.equal(i.severity_known, true); assert.equal(i.event, null);
  assert.notEqual(i.quality, "UNRELIABLE"); assert.ok(["VALID", "DEGRADED"].includes(i.quality));
  assert.ok(trs(g).every(x => x.kind === "QUALITY_CHANGE"), "only quality bookkeeping, no stress transitions");
  const samples = g.store.db.prepare("SELECT COUNT(*) n FROM stress_samples").get().n;
  assert.ok(samples >= 2 && samples <= 4, "about one sample per minute, not per tick: " + samples);
  assert.ok(i.context.open_interest === 1000 && i.context.funding_rate === 0.0001, "open interest and funding are shown as context");
  assert.equal(g.store.db.prepare("SELECT COUNT(*) n FROM stress_state").get().n, 1);
});

test("warm-up is honest: too little history gives UNKNOWN severity and UNRELIABLE quality, never NORMAL", () => {
  const g = rig({ nCandles: 200 }); g.run(60);
  const i = inst(g);
  assert.equal(i.severity, null); assert.equal(i.severity_known, false); assert.equal(i.quality, "UNRELIABLE");
  assert.ok(i.reasons.some(x => /baseline not ready/.test(x)));
  assert.equal(g.mon.gate(ID).code, "STRESS_DATA_UNRELIABLE");
});

test("abrupt move: an event opens with a stable id and onset, severity reaches CRITICAL, SHADOW records the verdict without blocking, ENFORCE would block", () => {
  const g = rig(); g.run(120);
  const drop = SIG * Math.sqrt(5) * S.CONFIG.thresholds.P[2] * 2.5;                         // far beyond the CRITICAL threshold over 5 minutes
  const p0 = g.price;
  g.run(360, e => p0 * (1 - drop * Math.min(1, e / 300)));
  const i = inst(g);
  assert.equal(i.severity, "CRITICAL"); assert.ok(i.event && /^stress:bitget:perp:BTCUSDT:\d+$/.test(i.event.event_id));
  const open = trs(g, "WHERE kind='EVENT_OPEN'"); assert.equal(open.length, 1);
  assert.ok(open[0].onset_ts <= open[0].ts && open[0].ts - open[0].onset_ts >= S.CONFIG.persistence.escalateMs, "confirmation lags onset by at least the persistence time");
  assert.equal(open[0].origin, "LIVE"); assert.equal(open[0].config_version, "stress-v1"); assert.equal(open[0].calibration, S.CONFIG.calibration.status);
  assert.ok(open[0].ts - open[0].onset_ts <= S.CONFIG.maxDetectionDelayMs + 5000, "detection delay within the documented maximum for an immediate move");
  const gt = g.mon.gate(ID); assert.equal(gt.would_block, true); assert.equal(gt.enforced, false); assert.equal(gt.mode, "SHADOW"); assert.equal(gt.code, "STRESS_CRITICAL_MARKET");
  assert.equal(i.trend.state === "STEADY" || i.trend.state === "WORSENING", true);
  const ev = g.mon.snapshot().events[0]; assert.equal(ev.peak, "CRITICAL"); assert.equal(ev.end_ts, null);
  const enforced = S.entryGate({ states: g.mon.state, instrumentId: ID, nowTs: g.now(), mode: "ENFORCE" }); assert.equal(enforced.enforced, true);
});

test("baseline is frozen at the event onset: a continuing crash does not normalise itself", () => {
  const g = rig(); g.run(120);
  const p0 = g.price, drop = SIG * Math.sqrt(5) * S.CONFIG.thresholds.P[2] * 2.5;
  g.run(400, e => p0 * (1 - drop * Math.min(1, e / 300)));
  const ref1 = g.mon.detail[ID].baseline.ref_end_ts, onset = g.mon.state[ID].event_onset_ts;
  assert.ok(ref1 <= onset - S.CONFIG.baseline.excludeMs + MIN, "reference ends before the event onset (minus the exclusion window)");
  g.run(600, () => g.price * (1 + SIG * 0.4 * (Math.random() > 0.5 ? 1 : -1)));            // 10 more minutes of high-volatility chop
  assert.equal(g.mon.detail[ID].baseline.ref_end_ts, ref1, "the reference did not move while the event is active");
});

test("disconnect during an event: severity and last valid time are retained, quality is UNRELIABLE, the event is NOT closed as recovered", () => {
  const g = rig(); g.run(120);
  const p0 = g.price, drop = SIG * Math.sqrt(5) * S.CONFIG.thresholds.P[2] * 2.5;
  g.run(360, e => p0 * (1 - drop * Math.min(1, e / 300)));
  const before = g.mon.state[ID]; assert.equal(before.severity, "CRITICAL");
  g.run(40 * 60, () => null);                                                                // 40 minutes without any ticker data
  const i = inst(g);
  assert.equal(i.quality, "UNRELIABLE"); assert.equal(i.severity, "CRITICAL", "severity retained");
  assert.equal(i.trend.state, "UNKNOWN", "no improving/worsening claim is made from unreliable data");
  assert.ok(i.last_valid.ts >= before.last_valid_ts && i.last_valid.ts <= before.last_valid_ts + 20000, "last valid measurement time stopped advancing");
  assert.equal(trs(g, "WHERE kind IN ('EVENT_CLOSE','DEESCALATE')").length, 0);
  assert.equal(g.mon.gate(ID).code, "STRESS_DATA_UNRELIABLE");
  g.mon.stop();
});

test("restart: a short gap resumes the event; a long gap closes it as UNOBSERVED (never RECOVERED) and keeps the last valid severity for display", () => {
  const file = tmpDb(), g = rig({ file }); g.run(120);
  const p0 = g.price, drop = SIG * Math.sqrt(5) * S.CONFIG.thresholds.P[2] * 2.5;
  g.run(360, e => p0 * (1 - drop * Math.min(1, e / 300)));
  const id0 = g.mon.state[ID].event_id; assert.ok(id0); const lastEval = g.mon.state[ID].last_eval_ts; g.mon.stop();
  g.set(lastEval + 60000);                                                                   // 1 minute later: a quick restart
  const m2 = g.mk(); assert.equal(m2.state[ID].event_id, id0, "short restart resumes the same event"); assert.equal(m2.state[ID].severity, "CRITICAL");
  m2.stop();
  g.set(lastEval + 20 * 60000);                                                              // 20 minutes later: not observed
  const m3 = g.mk(); const s3 = m3.state[ID];
  assert.equal(s3.event_id, null); assert.equal(s3.last_valid_severity, "CRITICAL"); assert.equal(s3.unobserved_since_ts, lastEval); assert.equal(s3.quality, "UNRELIABLE");
  const end = trs(g, "WHERE kind='EVENT_END_UNOBSERVED'"); assert.equal(end.length, 1); assert.equal(end[0].event_id, id0); assert.equal(end[0].ts, lastEval);
  assert.equal(trs(g, "WHERE kind='EVENT_CLOSE'").length, 0, "an unobserved gap is not a recovery");
  const snap = m3.snapshot(); const ev = snap.events.find(e => e.event_id === id0); assert.equal(ev.end_reason, "UNOBSERVED");
  const i3 = snap.instruments[0]; assert.equal(i3.last_valid.severity, "CRITICAL"); assert.ok(i3.unobserved_since_ts);
  m3.stop();
});

test("liquidity family: spread widening and depth collapse raise severity once the monitor's own baseline exists; warm-up is reported", () => {
  const g = rig(); const ins = g.store.db.prepare("INSERT INTO stress_samples (instrument_id, ts, spread_bps, depth_bid, depth_ask, depth_min, last, oi, funding, imbalance, origin) VALUES (?,?,?,?,?,?,?,?,?,?, 'LIVE')");
  g.run(30); assert.ok(inst(g).reasons.some(x => /spread baseline warming up/.test(x)), "no baseline yet: reported, not treated as normal");
  for (let k = 1; k <= 400; k++) ins.run(ID, T0 - 20 * MIN - k * MIN, 0.17, 2e6, 2e6, 2e6, 60000, 1000, 0.0001, 0);
  g.mon.cache[ID].lbase = null;
  g.collector.books[ID].top = () => ({ bids: [["59999.9", "1"]], asks: [["60000", "1"]] });          // depth collapses to ~60k USDT per side (3% of normal)
  g.run(60, () => g.price);
  const i = inst(g); assert.ok(i.measures.D !== null && i.measures.D < 0.12, "depth ratio " + i.measures.D);
  assert.ok(["HIGH_STRESS", "CRITICAL"].includes(i.severity), i.severity);
  assert.match(i.rule, /liquidity/);
});

test("isolation: a FORWARD monitor refuses synthetic scenarios; the database refuses synthetic rows in a FORWARD file; TEST rows are labelled SYNTHETIC_FIXTURE", () => {
  assert.throws(() => rig({ env: "FORWARD", synthetic: () => null }), /TEST environment only/);
  const f = rig({ env: "FORWARD" });
  assert.throws(() => f.store.db.prepare("INSERT INTO stress_transitions (instrument_id, ts, recorded_ts, kind, config_version, policy_version, mode, calibration, origin) VALUES ('x', 1, 1, 'K', 'v', 'p', 'SHADOW', 'c', 'SYNTHETIC_FIXTURE')").run(), /refused in a FORWARD database/);
  assert.throws(() => f.store.db.prepare("INSERT INTO stress_samples (instrument_id, ts, origin) VALUES ('x', 1, 'SYNTHETIC_FIXTURE')").run(), /refused in a FORWARD database/);
  // append-only: even a LIVE row cannot be edited or deleted
  f.store.db.prepare("INSERT INTO stress_transitions (instrument_id, ts, recorded_ts, kind, config_version, policy_version, mode, calibration, origin) VALUES ('x', 1, 1, 'K', 'v', 'p', 'SHADOW', 'c', 'LIVE')").run();
  assert.throws(() => f.store.db.prepare("UPDATE stress_transitions SET kind='X'").run(), /append-only/);
  assert.throws(() => f.store.db.prepare("DELETE FROM stress_transitions").run(), /append-only/);
  // TEST + synthetic scenario: every stress row is labelled, and a real (LIVE-origin) monitor on the same database would not read them
  const SF = require("../server/stress_fixture"), cfg = SF.config(S.CONFIG), t0 = T0;
  const g = rig({ env: "TEST", cfg, synthetic: SF.scenario(cfg, "BTCUSDT", t0) }); g.run(100);
  const rows = trs(g); assert.ok(rows.length > 0 && rows.every(x => x.origin === "SYNTHETIC_FIXTURE"), "every synthetic row is labelled");
  assert.ok(rows.some(x => x.kind === "EVENT_OPEN"), "the scripted crash opened an event");
  assert.equal(g.mon.snapshot().config.origin, "SYNTHETIC_FIXTURE"); assert.equal(g.mon.snapshot().config.calibration.status, "SYNTHETIC_FIXTURE");
  assert.equal(g.store.db.prepare("SELECT COUNT(*) n FROM stress_samples WHERE origin='SYNTHETIC_FIXTURE'").get().n, 0, "per-minute samples are REAL measurements, never labelled synthetic");
  // the scripted outage while CRITICAL retains severity (the browser test relies on this too)
  g.run(150);   // t = 250 s: past the outage (75-85 s), recovery in progress
  assert.ok(g.store.db.prepare("SELECT COUNT(*) n FROM stress_transitions WHERE kind='QUALITY_CHANGE' AND to_quality='UNRELIABLE'").get().n >= 1, "the scripted data outage was recorded as a quality change");
});
