"use strict";
/* Admin tooling must never migrate or alter a database it only reads, and must refuse one whose schema does not match the code. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { Store, MIGRATIONS } = require("../server/store");
const { Ledger } = require("../server/ledger");
const A = require("../server/admin");
const { NewsIngester, SOURCES } = require("../server/news");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-adm-"));
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
function currentDb(dir) {
  const f = path.join(dir, "m.db"), st = new Store(f), led = new Ledger(st, { now: () => Date.UTC(2026, 10, 16, 9), codeRev: "t" });
  led.append({ entry_id: "decision:t:1", kind: "decision", versions: { v: 1 }, payload: { intent: "WAIT" } }); st.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); st.close(); return f;
}
function oldDb(dir, version) {                                                                // a database written by older code
  const f = path.join(dir, "old.db"), d = new DatabaseSync(f);
  for (let i = 0; i < version; i++) d.exec(MIGRATIONS[i]);
  d.exec(`PRAGMA user_version=${version}`); d.close(); return f;
}

test("read-only admin commands leave the database file byte-for-byte unchanged and verify the chain", () => {
  const dir = tmp(), f = currentDb(dir), before = sha(f);
  const ro = A.openReadOnly(f); A.requireCurrent(ro, "t");
  assert.equal(new Ledger(ro).verify().ok, true);
  const ev = A.exportEvidence(ro); assert.equal(ev.ledger_entries.length, 1); assert.equal(ev.schema_version, MIGRATIONS.length); assert.ok(ev.database.db_id === undefined || typeof ev.database.db_id === "string");
  ro.db.close();
  assert.equal(sha(f), before, "nothing was written");
  const dest = path.join(dir, "bk", "copy.db"); A.main(["node", "admin", "backup", dest, "--db", f]);
  const chk = new DatabaseSync(dest, { readOnly: true }); assert.equal(chk.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); chk.close();
  assert.equal(sha(f), before, "backup does not modify the source"); assert.throws(() => A.main(["node", "admin", "backup", dest, "--db", f]), /exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a database that is behind (or ahead of) the code is refused, not migrated, by every tool", () => {
  const dir = tmp(), f = oldDb(dir, 6), before = sha(f);
  const ro = A.openReadOnly(f); assert.equal(ro.version, 6); assert.equal(ro.current, false);
  assert.throws(() => A.requireCurrent(ro, "status"), new RegExp(`schema v6 but this code expects v${MIGRATIONS.length}.*Back it up, then start the worker`)); ro.db.close();
  assert.throws(() => new Store(f, { requireCurrent: true }), /does not match this code/);
  assert.throws(() => A.main(["node", "admin", "kill-switch", "on", "all", "--db", f]), /does not match this code/);
  assert.throws(() => A.main(["node", "admin", "verify-ledger", "--db", f]), /schema v6/);
  assert.throws(() => A.main(["node", "admin", "status", "--db", path.join(dir, "missing.db")]), /not found/);
  assert.equal(sha(f), before, "the old-schema file was never touched");
  const ahead = oldDb(tmp(), MIGRATIONS.length); const d = new DatabaseSync(ahead); d.exec(`PRAGMA user_version=${MIGRATIONS.length + 1}`); d.close();
  const r2 = A.openReadOnly(ahead); assert.throws(() => A.requireCurrent(r2, "x"), /newer code/); r2.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("news back-off survives a restart: a source that answered 403 is not asked again until its wait is over", async () => {
  const dir = tmp(), f = path.join(dir, "m.db"); let t = Date.UTC(2026, 10, 16, 9), calls = 0;
  const sec = SOURCES.filter(s => s.id === "sec_press");
  let store = new Store(f, { now: () => t }), n = new NewsIngester({ store, now: () => t, sources: sec, spacingMs: 0 });
  n.fetchImpl = async () => { calls++; return { status: 403, text: async () => "<title>SEC.gov | Request Rate Threshold Exceeded</title>", headers: { get: () => null } }; };
  await n.poll(true); assert.equal(calls, 1); store.close();
  t += 11 * 60000; store = new Store(f, { now: () => t });                                        // worker restarted 11 minutes later
  n = new NewsIngester({ store, now: () => t, sources: sec, spacingMs: 0 }); n.fetchImpl = async () => { calls++; throw new Error("must not be called"); };
  assert.equal(n.sourceHealth()[0].status, "RATE_LIMITED_BACKOFF");
  const r = await n.poll(); assert.equal(r.sec_press.skipped, "backoff"); assert.equal(calls, 1, "no request during the restored back-off");
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
