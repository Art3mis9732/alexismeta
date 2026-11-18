"use strict";
/* Valuation recorder: bounded samples, honest coverage, no effect on the ledger or accounting, v10 migration. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Store, MIGRATIONS } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const { Monitor } = require("../server/monitor");
const { Health } = require("../server/health");
const { ValuationRecorder, coverageOf } = require("../server/valuation_recorder");
const { buildInfo } = require("../server/runtime");
const { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const ID = "bitget:perp:BTCUSDT", CLOSE = Date.UTC(2026, 10, 16, 9), MIN = 60000;
function rig(file = ":memory:") {
  let t = CLOSE + 3000; const now = () => t, store = new Store(file, { now }), ledger = new Ledger(store, { now, codeRev: "test" });
  store.upsertInstrument(fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", t));
  const book = { state: "VALID", recvTs: t, top: () => ({ bids: [["64900", "1000"]], asks: [["64900.1", "1000"]] }) };
  const tk = { last: "64900", bid: "64899.9", ask: "64900", mark: "64900", index_px: "64900", exch_ts: t, recv_ts: t, funding_rate: "0.0001", next_funding_ts: CLOSE + 4 * 3600000 };
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: { [ID]: tk }, books: { [ID]: book } };
  const health = new Health({ now });
  const snap = { instrument_id: ID, bar_close_ts: CLOSE, decision_ts: CLOSE + 3000, hash: "h1", missing: [], health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
    trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.02, bid: 64899.9, ask: 64900, depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, data_cutoff_ts: CLOSE + 2000,
    triggers: [{ code: "RETEST_UP", name: "RETEST_UP", dir: 1, stop: 64600, level: null }] };
  const engine = new PaperEngine({ store, ledger, collector, health, now, buildSnapshot: () => snap }); engine.feedHealthy = () => true;
  const runtime = { build: buildInfo(), instance_id: engine.instanceId, started_at: t, database: store.identity("FORWARD"), engine_error: null };
  const monitor = new Monitor({ store, collector, health, getEngine: () => engine, runtime, now, labDir: "/nonexistent-lab-dir" });
  const at = (v, mark) => { t = v; book.recvTs = v; tk.recv_ts = v; tk.exch_ts = v; if (mark !== undefined) { if (mark === null) delete tk.mark; else tk.mark = String(mark); } };
  return { store, ledger, engine, monitor, collector, book, tk, at, now: () => t, rec: new ValuationRecorder({ store, monitor, now }) };
}
const count = (r, tbl) => r.store.db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n;

test("one sample per open position and per account per minute; repeated ticks inside a minute write nothing more", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const t0 = Math.floor((CLOSE + 3000) / MIN) * MIN + MIN;                                      // next whole minute
  r.at(t0 + 5000, 65000); const n1 = r.rec.tick(); assert.equal(n1, 3 + 3, "3 positions + 3 accounts");
  let heavy = 0; const orig = r.monitor.positions.bind(r.monitor); r.monitor.positions = () => { heavy++; return orig(); };
  for (let k = 1; k <= 5; k++) { r.at(t0 + 5000 + k * 5000, 65000 + k); assert.equal(r.rec.tick(), 0, "same minute: nothing"); }
  assert.equal(heavy, 0, "inside a minute the recorder must not recompute the full valuation at all (it is called every 15 s)");
  r.monitor.positions = orig;
  r.at(t0 + MIN + 2000, 65100); assert.equal(r.rec.tick(), 6);
  assert.equal(count(r, "paper_valuation_samples"), 6); assert.equal(count(r, "paper_equity_samples"), 6);
  const row = r.store.db.prepare("SELECT * FROM paper_valuation_samples WHERE ts=? AND position_id LIKE '%risk_taker%'").get(t0 + MIN);
  assert.ok(row.mark === 65100 && row.gross_unrealized > 0 && row.net_if_closed !== null && row.margin_allocated > 0, JSON.stringify(row));
});

test("a missing mark is recorded as NULL (never 0) with its status; an unavailable equity is not recorded as a number", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const t0 = Math.floor((CLOSE + 3000) / MIN) * MIN + MIN; r.at(t0 + 1000, null); r.rec.tick();
  const rows = r.store.db.prepare("SELECT * FROM paper_valuation_samples").all();
  assert.ok(rows.length === 3 && rows.every(x => x.mark === null && x.gross_unrealized === null && x.mark_status === "UNAVAILABLE"), JSON.stringify(rows[0]));
  assert.equal(count(r, "paper_equity_samples"), 0, "mark equity is unavailable with a missing mark: nothing recorded rather than a guessed number");
});

test("running peak and drawdown come from the recorded samples; the peak survives a restart; coverage and gaps are reported", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vr-")), "t.db"), r = rig(file); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const t0 = Math.floor((CLOSE + 3000) / MIN) * MIN + MIN, marks = [65000, 65500, 64000, 64500];                 // equity up, up, down, partly back
  marks.forEach((m, i) => { r.at(t0 + i * MIN + 1000, m); r.rec.tick(); });
  const eq = r.store.db.prepare("SELECT ts, mark_equity, peak, drawdown_pct FROM paper_equity_samples WHERE analyst='risk_taker' ORDER BY ts").all();
  assert.equal(eq.length, 4); assert.equal(eq[1].peak, eq[1].mark_equity, "the peak is the highest recorded equity"); assert.equal(eq[2].peak, eq[1].mark_equity);
  assert.ok(Math.abs(eq[2].drawdown_pct - (eq[2].mark_equity / eq[1].mark_equity - 1) * 100) < 1e-9 && eq[2].drawdown_pct < 0);
  const dd = r.monitor.drawdownRecorded("risk_taker"); assert.ok(Math.abs(dd.max_pct - eq[2].drawdown_pct) < 1e-9, "max drawdown = the worst recorded sample"); assert.equal(dd.samples, 4); assert.match(dd.basis, /intra-gap peaks and troughs are not included/);
  const acct = r.monitor.accounts().accounts.find(a => a.analyst === "risk_taker"); assert.ok(acct.drawdown_recorded && acct.drawdown_recorded.samples === 4);
  // restart: a new recorder continues from the stored peak, not from the current equity
  const rec2 = new ValuationRecorder({ store: r.store, monitor: r.monitor, now: r.now }); r.at(t0 + 4 * MIN + 1000, 64200); rec2.tick();
  const last = r.store.db.prepare("SELECT peak FROM paper_equity_samples WHERE analyst='risk_taker' ORDER BY ts DESC LIMIT 1").get(); assert.equal(last.peak, eq[1].mark_equity, "peak survived the restart");
  // coverage: nothing recorded between minute 4 and minute 15 -> one gap of 11 minutes
  r.at(t0 + 15 * MIN + 1000, 64300); rec2.tick();
  const cov = coverageOf(r.store.db.prepare("SELECT ts FROM paper_equity_samples WHERE analyst='risk_taker' ORDER BY ts").all());
  assert.equal(cov.gaps.length, 1); assert.equal(cov.gaps[0].ms, 11 * MIN, "samples at minute 4 and minute 15"); assert.ok(cov.coverage < 1 && cov.count === 6);
  const det = r.monitor.detail(r.store.db.prepare("SELECT position_id FROM paper_positions WHERE analyst='risk_taker'").get().position_id);
  assert.ok(det.timeline.samples.length >= 5 && det.timeline.coverage.gaps.length >= 1 && /never reconstructed/.test(det.timeline.basis), "timeline reports its own gaps");
  r.store.db.close();
});

test("the recorder writes ONLY its two sample tables: the ledger, fills, positions and portfolios are untouched, and no sample exists for a closed position's later minutes", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const snapshotOf = () => JSON.stringify([r.store.db.prepare("SELECT * FROM ledger_entries ORDER BY seq").all(), r.store.db.prepare("SELECT * FROM paper_fills ORDER BY fill_id").all(), r.store.db.prepare("SELECT * FROM paper_positions ORDER BY position_id").all(), r.store.db.prepare("SELECT * FROM paper_portfolios ORDER BY analyst").all(), r.store.db.prepare("SELECT * FROM paper_events ORDER BY seq").all()]);
  const before = snapshotOf(), t0 = Math.floor((CLOSE + 3000) / MIN) * MIN + MIN;
  for (let k = 0; k < 5; k++) { r.at(t0 + k * MIN + 500, 65000 + k * 10); r.rec.tick(); }
  assert.equal(snapshotOf(), before, "nothing outside the sample tables changed"); assert.equal(r.ledger.verify().ok, true);
  const ids = r.store.db.prepare("SELECT position_id FROM paper_positions WHERE analyst='risk_taker'").get().position_id;
  r.engine.close(r.store.db.prepare("SELECT * FROM paper_positions WHERE position_id=?").get(ids), 65100, r.now(), "test", 0);
  const nBefore = r.store.db.prepare("SELECT COUNT(*) n FROM paper_valuation_samples WHERE position_id=?").get(ids).n;
  r.at(t0 + 6 * MIN + 500, 65200); r.rec.tick();
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM paper_valuation_samples WHERE position_id=?").get(ids).n, nBefore, "a closed position is no longer sampled");
});

test("storage is bounded: three hours of ticks write at most one row per position/account per minute; retention prunes after 30 days", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000); const t0 = Math.floor((CLOSE + 3000) / MIN) * MIN + MIN;
  for (let s = 0; s < 180 * 60; s += 15) { r.at(t0 + s * 1000, 65000); r.rec.tick(); }
  assert.ok(count(r, "paper_valuation_samples") <= 3 * 180 && count(r, "paper_equity_samples") <= 3 * 180, `${count(r, "paper_valuation_samples")} / ${count(r, "paper_equity_samples")}`);
  const del = r.store.prune(t0 + 31 * 86400000); assert.ok(del.paper_valuation_samples > 0 && del.paper_equity_samples > 0); assert.equal(count(r, "paper_valuation_samples"), 0);
  assert.equal(r.ledger.verify().ok, true, "pruning samples never touches the ledger");
});

test("migration v8 -> latest is additive: existing rows are kept; sample, stress and news-shadow tables are added", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mig-")), "v8.db"), d = new DatabaseSync(f);
  for (let i = 0; i < 8; i++) d.exec(MIGRATIONS[i]); d.exec("PRAGMA user_version=8");
  d.prepare("INSERT INTO meta (key, value) VALUES ('environment','FORWARD')").run(); d.prepare("INSERT INTO feed_events (ts, feed, event, detail) VALUES (1,'x','y','z')").run(); d.close();
  const s = new Store(f); assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length); assert.equal(MIGRATIONS.length, 12);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM feed_events").get().n >= 1, true);
  for (const t of ["paper_valuation_samples", "paper_equity_samples", "stress_transitions", "news_shadow"]) assert.ok(s.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(t), t);
  assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='environment'").get().value, "FORWARD"); s.close();
});
