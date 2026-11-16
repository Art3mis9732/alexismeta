"use strict";
/* Append-only prediction & decision ledger.
 *
 *   forecast / setup / decision  = ORIGINAL records, written before their outcome is knowable
 *   status                        = later lifecycle events that reference an original (never edits it)
 *   outcome                       = evaluation result, appended separately, only once the original is due
 *
 * Guarantees enforced here and in the DB (store.js migration v2):
 *   - no UPDATE / DELETE (triggers); retention never touches this table
 *   - entry_id is the idempotency key: re-appending identical content returns the existing row; different
 *     content under the same id is refused (no silent rewrite, no duplicate trigger after a retry)
 *   - data_cutoff_ts <= created_ts (no information from after the decision)
 *   - an outcome cannot be appended before the original's eval_due_ts
 *   - SHA-256 hash chain over (prev_hash, canonical row) -> verify() detects edits made outside the app
 *   - data_mode LIVE | REPLAY is part of the hashed row: a replayed decision can never pass as a forward one
 * Convention for callers: entry_id is DETERMINISTIC from (policy, version, instrument, bar close), e.g.
 *   "setup:balanced-v1:bitget:perp:BTCUSDT:1794816000000" - so a retry after a reconnect or restart hits the
 *   idempotency rule above instead of creating a second trigger.
 * A local SQLite file can still be replaced wholesale by someone with file access; backups plus the chain's
 * head hash (recorded elsewhere) are what make that detectable. */

const crypto = require("node:crypto");

const GENESIS = "0".repeat(64);
const ORIGINAL = new Set(["forecast", "setup", "decision"]);

function canonical(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("ledger: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

function rowHash(prevHash, r) {
  const body = canonical({ entry_id: r.entry_id, kind: r.kind, data_mode: r.data_mode, ref_id: r.ref_id, created_ts: r.created_ts, data_cutoff_ts: r.data_cutoff_ts,
    eval_due_ts: r.eval_due_ts, code_rev: r.code_rev, versions: r.versions, payload: r.payload });
  return crypto.createHash("sha256").update(prevHash + "\n" + body).digest("hex");
}

class Ledger {
  constructor(store, { now = Date.now, codeRev = "unknown" } = {}) {
    this.db = store.db; this.now = now; this.codeRev = codeRev;
    this.st = {
      head: this.db.prepare("SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1"),
      byId: this.db.prepare("SELECT * FROM ledger_entries WHERE entry_id = ?"),
      insert: this.db.prepare(`INSERT INTO ledger_entries (entry_id, kind, data_mode, ref_id, created_ts, data_cutoff_ts, eval_due_ts, code_rev, versions, payload, prev_hash, hash)
                               VALUES (:entry_id, :kind, :data_mode, :ref_id, :created_ts, :data_cutoff_ts, :eval_due_ts, :code_rev, :versions, :payload, :prev_hash, :hash)`),
      all: this.db.prepare("SELECT * FROM ledger_entries ORDER BY seq"),
      recent: this.db.prepare("SELECT * FROM ledger_entries ORDER BY seq DESC LIMIT ?"),
      refs: this.db.prepare("SELECT * FROM ledger_entries WHERE ref_id = ? ORDER BY seq")
    };
  }

  /** Append one entry. `e` = { entry_id, kind, ref_id?, data_cutoff_ts?, eval_due_ts?, versions: {...}, payload: {...} } */
  append(e) {
    if (!e || typeof e.entry_id !== "string" || !/^[A-Za-z0-9:._|-]{1,200}$/.test(e.entry_id)) throw new Error("ledger: bad entry_id");
    if (!ORIGINAL.has(e.kind) && e.kind !== "status" && e.kind !== "outcome") throw new Error("ledger: bad kind " + e.kind);
    if (!e.versions || typeof e.versions !== "object") throw new Error("ledger: versions required (strategy/model/config)");
    const mode = e.data_mode === undefined ? "LIVE" : e.data_mode;
    if (mode !== "LIVE" && mode !== "REPLAY") throw new Error("ledger: data_mode must be LIVE or REPLAY");
    const created = this.now();
    const row = { entry_id: e.entry_id, kind: e.kind, data_mode: mode, ref_id: e.ref_id || null, created_ts: created,
      data_cutoff_ts: e.data_cutoff_ts === undefined ? null : e.data_cutoff_ts, eval_due_ts: e.eval_due_ts === undefined ? null : e.eval_due_ts,
      code_rev: e.code_rev || this.codeRev, versions: canonical(e.versions), payload: canonical(e.payload === undefined ? null : e.payload) };

    const existing = this.st.byId.get(row.entry_id);
    if (existing) {
      const same = existing.kind === row.kind && existing.data_mode === row.data_mode && existing.ref_id === row.ref_id && existing.payload === row.payload && existing.versions === row.versions &&
        existing.data_cutoff_ts === row.data_cutoff_ts && existing.eval_due_ts === row.eval_due_ts;
      if (same) return { ...existing, duplicate: true };
      throw new Error(`ledger: entry ${row.entry_id} already exists with different content (originals cannot be rewritten; append a status/new version instead)`);
    }
    if (row.data_cutoff_ts !== null && row.data_cutoff_ts > created) throw new Error("ledger: data_cutoff_ts is after the decision time");
    if (ORIGINAL.has(row.kind) && row.ref_id) throw new Error("ledger: originals do not reference another entry (use payload.supersedes for new versions)");
    if (!ORIGINAL.has(row.kind)) {
      if (!row.ref_id) throw new Error("ledger: status/outcome must reference an original entry");
      const orig = this.st.byId.get(row.ref_id);
      if (!orig) throw new Error("ledger: referenced entry " + row.ref_id + " does not exist");
      if (!ORIGINAL.has(orig.kind)) throw new Error("ledger: status/outcome must reference an original, not another status/outcome");
      if (orig.data_mode !== row.data_mode) throw new Error("ledger: status/outcome data_mode must match the original's");
      if (row.kind === "outcome" && orig.eval_due_ts !== null && created < orig.eval_due_ts) throw new Error("ledger: outcome before the evaluation due time");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const h = this.st.head.get();
      row.prev_hash = h ? h.hash : GENESIS;
      row.hash = rowHash(row.prev_hash, row);
      this.st.insert.run(row);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
    return { ...this.st.byId.get(row.entry_id), duplicate: false };
  }

  get(id) { return this.st.byId.get(id) || null; }
  history(id) { return { original: this.get(id), events: this.st.refs.all(id) }; }
  recent(n = 50) { return this.st.recent.all(n); }

  /** Re-walk the chain. Returns { ok, entries, head, firstBadSeq?, reason? }. */
  verify() {
    let prev = GENESIS, n = 0;
    for (const r of this.st.all.all()) {
      if (r.prev_hash !== prev) return { ok: false, entries: n, firstBadSeq: r.seq, reason: "broken link" };
      if (rowHash(prev, r) !== r.hash) return { ok: false, entries: n, firstBadSeq: r.seq, reason: "content does not match hash" };
      prev = r.hash; n++;
    }
    return { ok: true, entries: n, head: prev };
  }
}

module.exports = { Ledger, canonical, rowHash, GENESIS };
