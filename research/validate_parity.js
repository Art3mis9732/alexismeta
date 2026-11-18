"use strict";
/* VALIDATION 1 and 2: does the historical replay reproduce what the live system recorded?
 *   node research/validate_parity.js <forward-db-copy.db>           (read-only; use a copy or the live file, it is opened read-only)
 *  1. EVIDENCE PARITY: every candle-derived field of each recorded forward evidence snapshot vs the same bar rebuilt from native 15m history.
 *  2. DECISION PARITY: for each recorded LIVE decision that has a recorded context, decide() on the rebuilt snapshot (candle-only variant, benign microstructure) must give
 *     the same intent and code, except where the recorded code is a MICROSTRUCTURE/DATA refusal the replay cannot see (SPREAD, DEPTH, DATA_*, BOOK_INVALID, COVERAGE_GAP).
 * Every difference is listed with its recorded reason. No historical number is reportable until both pass. */
const { DatabaseSync } = require("node:sqlite");
const H = require("./hist"), S = require("./snapshots"), { decide, RULES } = require("../server/policies");
const FIELDS = ["trend_1h", "above_vwap", "vwap", "atr", "atr_pct", "atr_pctile", "change_24h", "rv_24h", "close"];
const MICRO_CODES = new Set(["SPREAD", "DEPTH", "DATA_MISSING", "DATA_STALE", "BOOK_INVALID", "COVERAGE_GAP", "SPREAD_UNKNOWN"]);
function run(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true }), native = {}, idx = {};
  for (const s of H.SYMS) { native[s] = H.loadNative15(s); idx[s] = new Map(native[s].map((r, i) => [r.open_ts + H.BAR, i])); }
  const out = { db: dbFile, evidence: { checked: 0, no_native_bar: 0, field_mismatches: [], trigger_mismatches: [] }, decisions: { checked: 0, same: 0, explained_microstructure: 0, unexplained: [], no_context: 0, version_other: 0 } };
  const snaps = db.prepare("SELECT hash, instrument_id, bar_close_ts, json FROM evidence_snapshots ORDER BY bar_close_ts").all(), byHash = new Map();
  for (const r of snaps) {
    const sym = r.instrument_id.split(":").pop(), i = idx[sym] && idx[sym].get(r.bar_close_ts); const rec = JSON.parse(r.json); byHash.set(r.hash, { sym, i, rec });
    if (i === undefined) { out.evidence.no_native_bar++; continue; }
    const re = S.snapshotAt(sym, native[sym], i); out.evidence.checked++;
    for (const f of FIELDS) { const a = rec[f], b = re[f]; const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) : a === b; if (!same) out.evidence.field_mismatches.push({ bar: new Date(r.bar_close_ts).toISOString(), sym, field: f, recorded: a, rebuilt: b }); }
    const ta = JSON.stringify((rec.triggers || []).map(t => [t.code, t.dir, t.stop === null ? null : +t.stop.toPrecision(10)]).sort()), tb = JSON.stringify((re.triggers || []).map(t => [t.code, t.dir, t.stop === null ? null : +t.stop.toPrecision(10)]).sort());
    if (ta !== tb) out.evidence.trigger_mismatches.push({ bar: new Date(r.bar_close_ts).toISOString(), sym, recorded: ta, rebuilt: tb });
  }
  const dec = db.prepare("SELECT entry_id, payload FROM ledger_entries WHERE kind='decision' ORDER BY seq").all();
  for (const r of dec) {
    const p = JSON.parse(r.payload), ver = r.entry_id.split(":")[1];
    if (!RULES[p.analyst] || RULES[p.analyst].version !== ver) { out.decisions.version_other++; continue; }
    if (!p.context) { out.decisions.no_context++; continue; }
    const h = byHash.get(p.evidence_hash); if (!h || h.i === undefined) continue;
    const re = S.snapshotAt(h.sym, native[h.sym], h.i), d = decide(p.analyst, re, p.context); out.decisions.checked++;
    if (d.intent === p.intent && d.code === p.code) out.decisions.same++;
    else if (MICRO_CODES.has(p.code)) out.decisions.explained_microstructure++;
    else out.decisions.unexplained.push({ bar: new Date(p.bar_close_ts).toISOString(), analyst: p.analyst, sym: h.sym, recorded: [p.intent, p.code], replay: [d.intent, d.code], why: p.why });
  }
  db.close(); out.pass = out.evidence.field_mismatches.length === 0 && out.evidence.trigger_mismatches.length === 0 && out.decisions.unexplained.length === 0 && out.evidence.checked > 0;
  return out;
}
if (require.main === module) { const r = run(process.argv[2]); console.log(JSON.stringify({ ...r, evidence: { ...r.evidence, field_mismatches: r.evidence.field_mismatches.slice(0, 12), trigger_mismatches: r.evidence.trigger_mismatches.slice(0, 12) }, decisions: { ...r.decisions, unexplained: r.decisions.unexplained.slice(0, 12) } }, null, 1)); process.exitCode = r.pass ? 0 : 2; }
module.exports = { run };
