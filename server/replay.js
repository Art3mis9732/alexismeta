"use strict";
/* Deterministic replay check: re-derive every recorded LIVE decision from its stored evidence snapshot and recorded
 * context, using the same policy code, and diff against the ledger.
 *
 *   node server/replay.js --verify [--db data/worker/market.db]
 *
 * Checks per decision: (1) the stored snapshot exists and its hash matches its content (snapshot not edited);
 * (2) the policy version recorded is the one in the code (otherwise reported as VERSION_CHANGED, not a mismatch);
 * (3) intent, reason code and setup reproduce exactly. Exit code 0 only when nothing differs.
 * This is replay of RECORDED forward decisions. A historical backtest over periods without recorded snapshots would
 * be assumption-based research and is not implemented here. */
const crypto = require("node:crypto");
const path = require("node:path");
const { Store } = require("./store");
const { canonical } = require("./ledger");
const { decide, RULES } = require("./policies");

function verifyReplay(store) {
  const rows = store.db.prepare("SELECT entry_id, payload FROM ledger_entries WHERE kind='decision' AND data_mode='LIVE' ORDER BY seq").all();
  const getSnap = store.db.prepare("SELECT json FROM evidence_snapshots WHERE hash=?");
  const out = { decisions: rows.length, reproduced: 0, mismatches: [], missing_snapshot: [], snapshot_tampered: [], version_changed: [], unverifiable_no_context: [] };
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    const s = getSnap.get(p.evidence_hash);
    if (!s) { out.missing_snapshot.push(r.entry_id); continue; }
    const snap = JSON.parse(s.json), { hash, ...body } = snap;
    if (hash !== p.evidence_hash || crypto.createHash("sha256").update(canonical(body)).digest("hex") !== hash) { out.snapshot_tampered.push(r.entry_id); continue; }
    const rule = RULES[p.analyst];
    const recordedVersion = r.entry_id.split(":")[1];
    if (!rule || rule.version !== recordedVersion) { out.version_changed.push(r.entry_id); continue; }
    if (!p.context) { out.unverifiable_no_context.push(r.entry_id); continue; }   // recorded before context logging (2026-11-16 08:43 UTC)
    const d = decide(p.analyst, snap, p.context);
    const same = d.intent === p.intent && d.code === p.code && canonical(d.setup) === canonical(p.setup);
    if (same) out.reproduced++; else out.mismatches.push({ entry_id: r.entry_id, recorded: [p.intent, p.code], replayed: [d.intent, d.code] });
  }
  out.ok = out.mismatches.length === 0 && out.missing_snapshot.length === 0 && out.snapshot_tampered.length === 0;
  return out;
}

if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf("--db");
  const db = i >= 0 ? path.resolve(a[i + 1]) : path.join(__dirname, "..", "data", "worker", "market.db");
  if (!a.includes("--verify")) { console.error("usage: node server/replay.js --verify [--db path]"); process.exit(1); }
  const store = new Store(db);
  try { const r = verifyReplay(store); console.log(JSON.stringify(r, null, 2)); process.exitCode = r.ok ? 0 : 2; } finally { store.db.close(); }
}

module.exports = { verifyReplay };
