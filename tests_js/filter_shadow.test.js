"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { FilterShadow, KS } = require("../server/filter_shadow"), { Store } = require("../server/store"), risk = require("../server/risk");
const MIN = 60000, T = Date.UTC(2026, 10, 18, 12, 0, 0), ID = "bitget:perp:BTCUSDT", cfg = risk.RISK_DEFAULTS;
const COST = (2 * cfg.taker + 2 * cfg.slipFrac) * 1e4;                                   // 16 bps
function rig(now = T + 5 * MIN) {
  const store = new Store(":memory:"), led = {}; let t = now;
  const fs = new FilterShadow({ db: store.db, ledger: { get: id => led[id] }, config: cfg, environment: "FORWARD", now: () => t });
  const add = (id, side, stopBps, tgtBps = 50, exitMin = 60) => { led[id] = { versions: { policy: "balanced-v1" }, payload: JSON.stringify({ analyst: "balanced", setup: { stop: 60000 * (1 - side * stopBps / 1e4), target: 60000 * (1 + side * tgtBps / 1e4), time_exit_ts: T + exitMin * MIN } }) };
    return fs.record({ analyst: "balanced", instrument_id: ID, decisionId: id, intent: side > 0 ? "OPEN_LONG" : "OPEN_SHORT", code: "OPENED", decisionTs: T, snap: { ask: 60000, bid: 60000, health: { ticker: "HEALTHY" }, book_state: "VALID", coverage_complete: true, spread_bps: 0.02, trend_1h: 1, atr_pctile: 0.4 } }); };
  const candle = (m, o, h, l, c) => store.db.prepare("INSERT OR REPLACE INTO candles (instrument_id, interval, open_ts, o, h, l, c, base_vol, quote_vol, final, exch_ts, recv_ts, persist_ts, source, schema_version, quality) VALUES (?, '1m', ?, ?, ?, ?, ?, '1', NULL, 1, 0, 0, 0, 'test', 1, '[]')").run(ID, T + m * MIN, String(o), String(h), String(l), String(c));
  return { store, fs, add, candle, at: v => { t = v; } };
}
test("filter shadow: records stop/cost/ratio and a would-allow flag for every predeclared K, long and short; non-entries record nothing; idempotent; append-only", () => {
  const r = rig(), a = r.add("d1", 1, 100), b = r.add("d2", -1, 40);
  assert.ok(Math.abs(a.stopBps - 100) < 1e-6 && Math.abs(a.cost - COST) < 1e-9 && Math.abs(a.ratio - COST / 100) < 1e-9);
  assert.deepEqual(KS.filter(K => a.allow[K]), KS.filter(K => 100 >= K * COST)); assert.deepEqual(KS.filter(K => b.allow[K]), KS.filter(K => 40 >= K * COST));
  assert.equal(r.fs.record({ analyst: "balanced", instrument_id: ID, decisionId: "x", intent: "WAIT", decisionTs: T, snap: {} }), null);
  r.add("d1", 1, 999); assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM filter_shadow").get().n, 2);
  const row = r.store.db.prepare("SELECT * FROM filter_shadow WHERE decision_id='d1'").get(); assert.equal(row.strategy_version, "balanced-v1"); assert.equal(row.environment, "FORWARD"); assert.ok(Math.abs(row.stop_bps - 100) < 1e-6);
  assert.throws(() => r.store.db.prepare("UPDATE filter_shadow SET stop_bps=1").run(), /append-only/); assert.throws(() => r.store.db.prepare("DELETE FROM filter_shadow").run(), /append-only/);
});
test("filter shadow: outcome is resolved only from contiguous stored candles with the replay's exit rule; net R is hand-checkable; nothing is inserted while the trade is still running", () => {
  const r = rig(T + 30 * MIN); r.add("w", 1, 100, 150);                                                // long, stop 100 bps, target 150 bps
  for (let m = 0; m < 4; m++) r.candle(m, 60000, 60010, 59990, 60000); assert.equal(r.fs.resolve(), 0, "still running: no outcome");
  r.candle(4, 60000, 60000 * 1.0151, 59990, 60500); r.at(T + 30 * MIN); assert.equal(r.fs.resolve(), 1);
  const o = r.store.db.prepare("SELECT * FROM filter_shadow_outcomes WHERE decision_id='w'").get(); assert.equal(o.status, "RESOLVED"); assert.equal(o.exit_reason, "target");
  const entry = 60000 * (1 + cfg.slipFrac), exit = 60000 * 1.015 * (1 - cfg.slipFrac), net = exit - entry - cfg.taker * (entry + exit); assert.ok(Math.abs(o.net_r - net / (60000 * 0.01)) < 1e-9, `${o.net_r}`); assert.match(o.basis, /hypothetical/);
  const l = rig(T + 30 * MIN); l.add("s", 1, 100, 150); l.candle(0, 60000, 60000, 59000, 59100); l.at(T + 30 * MIN); l.fs.resolve(); const so = l.store.db.prepare("SELECT * FROM filter_shadow_outcomes").get(); assert.equal(so.exit_reason, "stop"); assert.ok(so.net_r < -1);
});
test("filter shadow: a candle gap is recorded as UNRESOLVED_GAP after the window, never as an invented exit; before the window ends it stays pending", () => {
  const r = rig(T + 20 * MIN); r.add("g", 1, 100, 150, 10); for (const m of [0, 1, 2, 5, 6]) r.candle(m, 60000, 60010, 59990, 60000);
  assert.equal(r.fs.resolve(), 0, "window not over yet"); r.at(T + 10 * MIN + 16 * MIN); assert.equal(r.fs.resolve(), 1);
  const o = r.store.db.prepare("SELECT * FROM filter_shadow_outcomes").get(); assert.equal(o.status, "UNRESOLVED_GAP"); assert.equal(o.exit_reason, null); assert.equal(o.net_r, null);
  assert.equal(r.fs.resolve(), 0, "idempotent");
});
test("filter shadow: summary separates allowed from blocked and resolved from pending, without inventing a mean", () => {
  const r = rig(T + 30 * MIN); r.add("a", 1, 150, 600); r.add("b", 1, 20, 30); for (let m = 0; m < 3; m++) r.candle(m, 60000, 60010, 59990, 60000); r.candle(3, 60000, 60000, 59000, 59100); r.at(T + 30 * MIN); r.fs.resolve();
  const s = r.fs.summary(), k = s.by_analyst.balanced.by_k[6]; assert.equal(k.allowed, 1); assert.equal(k.blocked, 1); assert.equal(s.effect_on_decisions, "NONE"); assert.equal(s.by_analyst.balanced.resolved, 2);
  assert.ok(k.mean_r_blocked < -1 && k.mean_r_allowed < -0.5); const e = rig(); assert.deepEqual(e.fs.summary().by_analyst, {});
});
