"use strict";
/* Append-only ledger tests (Phase 2b).  node --test "tests_js/*.test.js" */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Store, MIGRATIONS } = require("../server/store");
const { Ledger, canonical } = require("../server/ledger");

const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
function setup() {
  let t = T0;
  const store = new Store(":memory:", { now: () => t });
  const led = new Ledger(store, { now: () => t, codeRev: "abc123" });
  return { store, led, at: v => { t = v; } };
}
const V = { strategy: "balanced-v1", config: "cfg-1" };
const forecast = (id, extra = {}) => ({ entry_id: id, kind: "forecast", data_cutoff_ts: T0 - 1000, eval_due_ts: T0 + 3600000, versions: V,
  payload: { target: "sign(ret_1h) beyond 5bps", instrument: "bitget:perp:BTCUSDT", score: 0.12, calibrated: false }, ...extra });

test("ledger: originals and outcomes are separate rows; the original is never modified", () => {
  const { led, at } = setup();
  const f = led.append(forecast("fc:1"));
  assert.equal(f.duplicate, false); assert.equal(f.code_rev, "abc123");
  at(T0 + 3600000);
  led.append({ entry_id: "fc:1:outcome", kind: "outcome", ref_id: "fc:1", versions: V, payload: { result: "MISS" } });
  const h = led.history("fc:1");
  assert.equal(h.original.payload, f.payload); assert.equal(h.events.length, 1); assert.equal(h.events[0].kind, "outcome");
});

test("ledger: database refuses UPDATE and DELETE, even from the application", () => {
  const { store, led } = setup();
  led.append(forecast("fc:2"));
  assert.throws(() => store.db.prepare("UPDATE ledger_entries SET payload='{}' WHERE entry_id='fc:2'").run(), /append-only/);
  assert.throws(() => store.db.prepare("DELETE FROM ledger_entries").run(), /append-only/);
  assert.equal(store.prune().ledger, undefined, "retention does not touch the ledger");
  assert.ok(led.get("fc:2"));
});

test("ledger: retries are idempotent; a changed payload under the same id is refused", () => {
  const { led } = setup();
  led.append(forecast("fc:3"));
  assert.equal(led.append(forecast("fc:3")).duplicate, true);
  assert.throws(() => led.append(forecast("fc:3", { payload: { score: 0.9 } })), /already exists with different content/);
  assert.equal(led.verify().entries, 1);
});

test("ledger: no future information, no early outcomes, no dangling references", () => {
  const { led, at } = setup();
  assert.throws(() => led.append(forecast("fc:4", { data_cutoff_ts: T0 + 1 })), /after the decision time/);
  led.append(forecast("fc:5"));
  at(T0 + 3599999);
  assert.throws(() => led.append({ entry_id: "fc:5:o", kind: "outcome", ref_id: "fc:5", versions: V, payload: {} }), /before the evaluation due time/);
  assert.throws(() => led.append({ entry_id: "x:s", kind: "status", ref_id: "nope", versions: V, payload: {} }), /does not exist/);
  assert.throws(() => led.append({ entry_id: "x:s2", kind: "status", versions: V, payload: {} }), /must reference/);
  led.append({ entry_id: "fc:5:s", kind: "status", ref_id: "fc:5", versions: V, payload: { state: "EXPIRED" } });
  assert.throws(() => led.append({ entry_id: "fc:5:s:s", kind: "status", ref_id: "fc:5:s", versions: V, payload: {} }), /reference an original/);
  assert.throws(() => led.append({ entry_id: "bad id!", kind: "forecast", versions: V, payload: {} }), /bad entry_id/);
  assert.throws(() => led.append({ entry_id: "nv", kind: "forecast", payload: {} }), /versions required/);
});

test("ledger: hash chain verifies, and detects an edit made behind the application's back", () => {
  const { store, led, at } = setup();
  for (let i = 0; i < 5; i++) { at(T0 + i * 1000); led.append(forecast("fc:c" + i, { data_cutoff_ts: T0 + i * 1000 - 1 })); }
  const v = led.verify();
  assert.equal(v.ok, true); assert.equal(v.entries, 5); assert.match(v.head, /^[0-9a-f]{64}$/);
  // An attacker with file access drops the trigger and edits a row.
  store.db.exec("DROP TRIGGER ledger_no_update");
  store.db.prepare("UPDATE ledger_entries SET payload = ? WHERE entry_id = 'fc:c2'").run(canonical({ score: 0.99 }));
  const bad = led.verify();
  assert.equal(bad.ok, false); assert.equal(bad.reason, "content does not match hash");
  assert.equal(bad.firstBadSeq, led.get("fc:c2").seq);
});

test("ledger: canonical JSON is key-order independent and rejects NaN/Infinity", () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.throws(() => canonical({ x: NaN }), /non-finite/);
});

test("ledger: an existing v1 database upgrades to v2 without losing market data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-mig-")), f = path.join(dir, "m.db");
  const raw = new DatabaseSync(f);
  raw.exec(MIGRATIONS[0]); raw.exec("PRAGMA user_version=1");
  raw.prepare("INSERT INTO feed_events (ts, feed, event, detail) VALUES (1,'x','y',NULL)").run(); raw.close();
  const st = new Store(f);
  assert.equal(st.db.prepare("PRAGMA user_version").get().user_version, require("../server/store").MIGRATIONS.length);
  assert.equal(st.count("feed_events"), 1); assert.equal(st.count("ledger_entries"), 0);
  st.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("ledger: survives a restart and continues the same chain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-led-")), f = path.join(dir, "m.db");
  let st = new Store(f, { now: () => T0 }); new Ledger(st, { now: () => T0 }).append(forecast("fc:r1")); st.close();
  st = new Store(f, { now: () => T0 + 5 });
  const led = new Ledger(st, { now: () => T0 + 5 });
  led.append(forecast("fc:r2"));
  const v = led.verify(); assert.equal(v.ok, true); assert.equal(v.entries, 2);
  assert.equal(led.get("fc:r2").prev_hash, led.get("fc:r1").hash);
  st.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("ledger: data_mode is part of the hashed row; replay outcomes cannot attach to live originals", () => {
  const { store, led, at } = setup();
  led.append(forecast("fc:live"));
  led.append(forecast("fc:replay", { data_mode: "REPLAY" }));
  assert.equal(led.get("fc:replay").data_mode, "REPLAY"); assert.equal(led.get("fc:live").data_mode, "LIVE");
  assert.throws(() => led.append(forecast("fc:x", { data_mode: "SIMULATED" })), /LIVE or REPLAY/);
  at(T0 + 3600000);
  assert.throws(() => led.append({ entry_id: "fc:live:o", kind: "outcome", ref_id: "fc:live", data_mode: "REPLAY", versions: V, payload: {} }), /must match/);
  assert.equal(led.append(forecast("fc:live")).duplicate, true);
  store.db.exec("DROP TRIGGER ledger_no_update");
  store.db.prepare("UPDATE ledger_entries SET data_mode='LIVE' WHERE entry_id='fc:replay'").run();   // relabel replay as live
  const v = led.verify(); assert.equal(v.ok, false); assert.equal(v.firstBadSeq, led.get("fc:replay").seq);
});
