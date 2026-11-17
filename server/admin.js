"use strict";
/* Local admin commands (operate on the worker DB; safe while the worker runs - SQLite serialises writers).
 *   node server/admin.js status                         portfolios, open positions, ledger check          (read-only)
 *   node server/admin.js verify-ledger                  re-walk the hash chain                              (read-only)
 *   node server/admin.js export-evidence <file>         forward records as JSON                             (read-only)
 *   node server/admin.js backup <file>                  consistent copy + integrity check                   (read-only on the source)
 *   node server/admin.js kill-switch on|off [analyst|all]                                                  (writes; schema must be current)
 * Options: --db <path> (default data/worker/market.db).
 * READ-ONLY commands open the database read-only: they never migrate it and never create it. If the file's schema is older
 * or newer than this code they say so, and the commands that need a current schema refuse; only the worker migrates a database
 * (after you have backed it up). There is deliberately no command that places, modifies or cancels a real order. */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Store, MIGRATIONS } = require("./store");
const { Ledger } = require("./ledger");
const { ANALYSTS } = require("./policies");

function openReadOnly(file) {
  if (!fs.existsSync(file)) throw new Error("database file not found: " + file);
  const db = new DatabaseSync(file, { readOnly: true }), v = db.prepare("PRAGMA user_version").get().user_version;
  return { db, version: v, current: v === MIGRATIONS.length, tx: fn => fn() };
}
function requireCurrent(ro, what) {
  if (!ro.current) throw new Error(`${what}: the database is at schema v${ro.version} but this code expects v${MIGRATIONS.length}. ` +
    `${ro.version < MIGRATIONS.length ? "Back it up, then start the worker once to migrate it." : "It was written by newer code; update the code instead."}`);
}
const rows = (db, sql, ...a) => db.prepare(sql).all(...a);
const meta = db => Object.fromEntries(rows(db, "SELECT key, value FROM meta WHERE key IN ('db_id','environment','created_ts')").map(r => [r.key, r.value]));

function exportEvidence(ro) {
  const { db } = ro; requireCurrent(ro, "export-evidence");
  return { exported_at_utc: new Date().toISOString(), schema_version: ro.version, database: meta(db),
    note: "Original records exported verbatim from a read-only connection. Hashes are the ledger chain values.",
    ledger_entries: rows(db, "SELECT * FROM ledger_entries ORDER BY seq"),
    evidence_snapshots: rows(db, "SELECT hash, instrument_id, bar_close_ts, created_ts, json FROM evidence_snapshots ORDER BY bar_close_ts").map(r => ({ ...r, json: JSON.parse(r.json) })),
    paper_positions: rows(db, "SELECT * FROM paper_positions ORDER BY opened_ts, analyst"), paper_fills: rows(db, "SELECT * FROM paper_fills ORDER BY ts, fill_id"),
    paper_funding: rows(db, "SELECT * FROM paper_funding ORDER BY settlement_ts"), paper_events: rows(db, "SELECT * FROM paper_events ORDER BY seq"),
    worker_events: rows(db, "SELECT ts, feed, event, detail FROM feed_events WHERE feed IN ('worker','bitget:ws') ORDER BY id"), coverage_gaps: rows(db, "SELECT * FROM coverage_gaps ORDER BY id") };
}

function main(argv) {
  const args = argv.slice(2); let db = path.join(__dirname, "..", "data", "worker", "market.db");
  const i = args.indexOf("--db"); if (i >= 0) { db = path.resolve(args[i + 1]); args.splice(i, 2); }
  const [cmd, a1, a2] = args;
  if (cmd === "status") {
    const ro = openReadOnly(db); try {
      requireCurrent(ro, "status");
      console.log(JSON.stringify({ schema_version: ro.version, database: meta(ro.db), portfolios: rows(ro.db, "SELECT * FROM paper_portfolios"),
        open_positions: rows(ro.db, "SELECT position_id, analyst, instrument_id, side, qty, entry, stop, target, gap_affected FROM paper_positions WHERE state='OPEN'"), ledger: new Ledger(ro).verify() }, null, 2));
    } finally { ro.db.close(); }
  } else if (cmd === "verify-ledger") {
    const ro = openReadOnly(db); try { requireCurrent(ro, "verify-ledger"); const v = new Ledger(ro).verify(); console.log(JSON.stringify(v)); process.exitCode = v.ok ? 0 : 2; } finally { ro.db.close(); }
  } else if (cmd === "export-evidence") {
    if (!a1) throw new Error("usage: export-evidence <file>");
    const ro = openReadOnly(db); try { const out = exportEvidence(ro); fs.writeFileSync(path.resolve(a1), JSON.stringify(out, null, 1));
      console.log(JSON.stringify({ file: path.resolve(a1), ledger_rows: out.ledger_entries.length, positions: out.paper_positions.length, fills: out.paper_fills.length, schema_version: out.schema_version })); } finally { ro.db.close(); }
  } else if (cmd === "backup") {
    if (!a1) throw new Error("usage: backup <file>");
    const dest = path.resolve(a1); if (fs.existsSync(dest)) throw new Error("backup target exists: " + dest);
    const ro = openReadOnly(db); try {
      fs.mkdirSync(path.dirname(dest), { recursive: true }); ro.db.prepare("VACUUM INTO ?").run(dest);
      const chk = new DatabaseSync(dest, { readOnly: true }); try { console.log(JSON.stringify({ file: dest, schema_version: ro.version, integrity: Object.values(chk.prepare("PRAGMA integrity_check").get())[0] })); } finally { chk.close(); }
    } finally { ro.db.close(); }
  } else if (cmd === "kill-switch") {
    if (a1 !== "on" && a1 !== "off") throw new Error("usage: kill-switch on|off [analyst|all]");
    const who = a2 || "all"; if (who !== "all" && !ANALYSTS.includes(who)) throw new Error("analyst must be one of " + ANALYSTS.join(", ") + " or all");
    const store = new Store(db, { requireCurrent: true });                                    // refuses a database that is behind this code
    try {
      const list = who === "all" ? ANALYSTS : [who];
      for (const a of list) store.db.prepare("UPDATE paper_portfolios SET kill_switch=?, updated_ts=? WHERE analyst=?").run(a1 === "on" ? 1 : 0, Date.now(), a);
      store.feedEvent("paper", a1 === "on" ? "kill_switch_on" : "kill_switch_off", list.join(",") + " (admin CLI)");
      console.log(`kill switch ${a1} for ${list.join(", ")}: new paper setups ${a1 === "on" ? "are rejected" : "are allowed"}; open positions keep their stops/targets/time exits.`);
    } finally { store.db.close(); }
  } else throw new Error("commands: status | verify-ledger | export-evidence <file> | backup <file> | kill-switch on|off [analyst|all]");
}

if (require.main === module) { try { main(process.argv); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { openReadOnly, requireCurrent, exportEvidence, main };
