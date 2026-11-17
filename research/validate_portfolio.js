"use strict";
/* VALIDATION 4: does simulate() itself (cooldown, portfolio coupling, sizing, one position per coin) reproduce the positions the forward worker OPENED?
 * Replays the forward window with the live rules and live risk defaults from the same starting equity, then compares the set of opened positions
 * (analyst, coin, decision bar, side) and, for matches, the quantity. Differences are listed: equity paths differ after a closed trade, microstructure is assumed benign.
 *   node research/validate_portfolio.js <forward-db-copy.db> */
const { DatabaseSync } = require("node:sqlite"), H = require("./hist"), SN = require("./snapshots"), SIM = require("./simulate"), risk = require("../server/risk");
const { ANALYSTS } = require("../server/policies"), { fromBitgetContract } = require("../server/instruments"), CONTRACTS = require("../tests_js/fixtures/bitget/contracts.json");
function run(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true }), BAR = H.BAR;
  const dec = db.prepare("SELECT payload FROM ledger_entries WHERE kind='decision'").all().map(r => JSON.parse(r.payload));
  const pos = db.prepare("SELECT position_id, analyst, instrument_id, side, qty, opened_ts, entry FROM paper_positions ORDER BY opened_ts").all();
  const from = Math.min(...dec.map(d => d.bar_close_ts)), to = Math.max(...dec.map(d => d.bar_close_ts)), snaps = {}, m1 = {}, funding = {}, inst = {};
  for (const s of H.SYMS) { const nat = H.loadNative15(s), i0 = nat.findIndex(r => r.open_ts + BAR === from), i1 = nat.findIndex(r => r.open_ts + BAR === to); snaps[s] = SN.buildAll(s, nat, { from: i0, to: i1 }); m1[s] = H.load1m(s); funding[s] = H.loadFunding(s);
    inst[s] = fromBitgetContract(CONTRACTS.data.find(c => c.symbol === s), "USDT-FUTURES", Date.now()); }
  const out = { db: dbFile, window: [new Date(from).toISOString(), new Date(to).toISOString()], recorded_positions: pos.length, matched: [], recorded_not_in_replay: [], replay_not_in_recorded: [] };
  const rec = new Map(pos.map(p => [`${p.analyst}|${p.instrument_id.split(":").pop()}|${p.position_id.split(":").pop()}|${p.side}`, p]));
  const seen = new Set();
  // The forward worker was DOWN for parts of this window, so the ledger has decisions only for some bars. A replay that also trades the unrecorded bars would change cooldowns and open
  // positions and diverge for that reason alone, so the replay may only act on bars where the ledger has a recorded decision for that analyst and coin.
  const recorded = new Set(dec.map(d => `${d.analyst}|${d.instrument_id.split(":").pop()}|${d.bar_close_ts}`)), { decide } = require("../server/policies");
  out.recorded_decision_bars = recorded.size;
  for (const a of ANALYSTS) {
    const policy = (an, snap, ctx) => (recorded.has(`${an}|${snap.instrument_id.split(":").pop()}|${snap.bar_close_ts}`) ? decide(an, snap, ctx) : { analyst: an, intent: "WAIT", code: "WORKER_DOWN_NO_RECORD" });
    const r = SIM.simulate({ analyst: a, snaps, m1, funding, instruments: inst, from, to, config: risk.RISK_DEFAULTS, label: "val:", policy });
    for (const t of r.trades) { const bar = t.opened_ts - 3000, key = `${a}|${t.sym}|${bar}|${t.side}`, p = rec.get(key); seen.add(key);
      if (p) out.matched.push({ key, replay_qty: t.qty, recorded_qty: Number(p.qty), qty_ratio: +(t.qty / Number(p.qty)).toFixed(3), replay_entry: +t.entry.toFixed(4), recorded_entry: p.entry });
      else out.replay_not_in_recorded.push({ key, entry: t.entry, reason_closed: t.reason }); }
  }
  for (const [k, p] of rec) if (!seen.has(k)) out.recorded_not_in_replay.push({ key: k, qty: p.qty });
  db.close(); out.verdict = out.recorded_not_in_replay.length === 0 && out.replay_not_in_recorded.length === 0 ? "SAME_POSITION_SET" : "DIFFERENT_POSITION_SET"; return out;
}
if (require.main === module) console.log(JSON.stringify(run(process.argv[2]), null, 1));
module.exports = { run };
