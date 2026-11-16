"use strict";
/* Local admin commands (operate on the worker DB; safe while the worker runs - SQLite serialises writers).
 *   node server/admin.js status                         portfolios, open positions, ledger head
 *   node server/admin.js kill-switch on|off [analyst|all]
 *   node server/admin.js verify-ledger
 *   node server/admin.js backup <file>                  consistent copy + integrity check
 * Options: --db <path> (default data/worker/market.db).
 * There is deliberately no command that places, modifies or cancels a real order. */
const path = require("node:path");
const { Store } = require("./store");
const { Ledger } = require("./ledger");
const { ANALYSTS } = require("./policies");

function main(argv) {
  const args = argv.slice(2); let db = path.join(__dirname, "..", "data", "worker", "market.db");
  const i = args.indexOf("--db"); if (i >= 0) { db = path.resolve(args[i + 1]); args.splice(i, 2); }
  const [cmd, a1, a2] = args;
  const store = new Store(db);
  try {
    if (cmd === "status") {
      console.log(JSON.stringify({ portfolios: store.db.prepare("SELECT * FROM paper_portfolios").all(),
        open_positions: store.db.prepare("SELECT position_id, analyst, instrument_id, side, qty, entry, stop, target FROM paper_positions WHERE state='OPEN'").all(),
        ledger: new Ledger(store).verify() }, null, 2));
    } else if (cmd === "kill-switch") {
      if (a1 !== "on" && a1 !== "off") throw new Error("usage: kill-switch on|off [analyst|all]");
      const who = a2 || "all"; if (who !== "all" && !ANALYSTS.includes(who)) throw new Error("analyst must be one of " + ANALYSTS.join(", ") + " or all");
      const list = who === "all" ? ANALYSTS : [who];
      for (const a of list) store.db.prepare("UPDATE paper_portfolios SET kill_switch=?, updated_ts=? WHERE analyst=?").run(a1 === "on" ? 1 : 0, Date.now(), a);
      store.feedEvent("paper", a1 === "on" ? "kill_switch_on" : "kill_switch_off", list.join(",") + " (admin CLI)");
      console.log(`kill switch ${a1} for ${list.join(", ")}: new paper setups ${a1 === "on" ? "are rejected" : "are allowed"}; open positions keep their stops/targets/time exits.`);
    } else if (cmd === "verify-ledger") {
      const v = new Ledger(store).verify(); console.log(JSON.stringify(v)); process.exitCode = v.ok ? 0 : 2;
    } else if (cmd === "backup") {
      if (!a1) throw new Error("usage: backup <file>");
      const b = store.backup(path.resolve(a1)); store.feedEvent("store", "backup", JSON.stringify(b)); console.log(JSON.stringify(b));
    } else throw new Error("commands: status | kill-switch on|off [analyst|all] | verify-ledger | backup <file>");
  } finally { store.db.close(); }
}

try { main(process.argv); } catch (e) { console.error(e.message); process.exitCode = 1; }
