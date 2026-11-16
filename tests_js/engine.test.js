"use strict";
/* Paper engine lifecycle tests (deterministic; snapshots are injected so the scenario is exact). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const { fromBitgetContract } = require("../server/instruments");
const { BAR } = require("../server/evidence");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const ID = "bitget:perp:BTCUSDT", CLOSE = Date.UTC(2026, 10, 16, 9);
const T = (code, dir, stop) => ({ code, name: code, dir, stop, level: null });
const snapOf = (o = {}) => ({ instrument_id: ID, bar_close_ts: CLOSE, decision_ts: CLOSE + 3000, hash: "snap-" + JSON.stringify(o).length, missing: [],
  health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
  trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.02, bid: 64899.9, ask: 64900,
  depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, data_cutoff_ts: CLOSE + 2000, triggers: [T("RETEST_UP", 1, 64600)], ...o });

function rig({ file = ":memory:", snap = snapOf(), t0 = CLOSE + 3000 } = {}) {
  let t = t0;
  const now = () => t, store = new Store(file, { now }), ledger = new Ledger(store, { now, codeRev: "test" });
  store.upsertInstrument(fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", t0));
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: { [ID]: { last: "64900", bid: "64899.9", ask: "64900", next_funding_ts: CLOSE + 4 * 3600000, recv_ts: t0 } }, books: {} };
  const health = { snapshot: () => ({ feeds: [] }) };
  let current = snap;
  const engine = new PaperEngine({ store, ledger, collector, health, now, buildSnapshot: () => current });
  let n = 0;
  const trade = (price, dt) => { t += dt; store.enqueue({ type: "trade", instrument_id: ID, trade_id: "9" + String(++n).padStart(18, "0"), exch_ts: t, recv_ts: t + 5, price: String(price), size: "0.01",
    venue_side: "buy", source: "test", schema_version: 1, quality: [] }); store.flush(); };
  return { store, ledger, engine, collector, trade, at: v => { t = v; }, now, setSnap: s => { current = s; } };
}
const pos = (store, a) => store.db.prepare("SELECT * FROM paper_positions WHERE analyst=?").get(a);

test("engine: S3 -> three decisions, three risk approvals, three paper fills at the ask plus slippage; ledger chain intact", () => {
  const r = rig(), out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(out.results.map(x => x.code), ["OPENED", "OPENED", "OPENED"]);
  const p = pos(r.store, "balanced");
  assert.ok(Math.abs(p.entry - 64900 * 1.0002) < 1e-6); assert.equal(p.state, "OPEN");
  const kinds = r.store.db.prepare("SELECT kind, json_extract(payload,'$.state') st FROM ledger_entries ORDER BY seq").all().map(x => x.kind + (x.st ? ":" + x.st : ""));
  assert.deepEqual(kinds, ["decision", "status:RISK_APPROVED", "status:POSITION_OPENED", "decision", "status:RISK_APPROVED", "status:POSITION_OPENED", "decision", "status:RISK_APPROVED", "status:POSITION_OPENED"]);
  assert.equal(r.ledger.verify().ok, true);
  const dq = Number(pos(r.store, "defensive").qty), bq = Number(p.qty), tq = Number(pos(r.store, "risk_taker").qty);
  assert.ok(dq < bq && bq < tq, "risk budgets 0.10% < 0.25% < 0.50%");
});

test("engine: positions are managed from the trade tape in exchange order; outcomes are appended, originals untouched", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const before = r.store.db.prepare("SELECT payload, hash FROM ledger_entries WHERE kind='decision'").all();
  r.trade(65000, 1000); r.trade(65360, 1000); r.engine.manage();          // 1.5R targets (65350-ish) hit; 2R not
  assert.equal(pos(r.store, "balanced").exit_reason, "target"); assert.equal(pos(r.store, "defensive").exit_reason, "target");
  assert.equal(pos(r.store, "risk_taker").state, "OPEN");
  r.trade(64590, 1000); r.engine.manage();
  const rt = pos(r.store, "risk_taker");
  assert.equal(rt.exit_reason, "stop"); assert.ok(rt.pnl < 0);
  assert.ok(pos(r.store, "balanced").pnl > 0);
  const eq = r.store.db.prepare("SELECT analyst, equity FROM paper_portfolios").all();
  assert.ok(eq.find(x => x.analyst === "risk_taker").equity < 1000 && eq.find(x => x.analyst === "balanced").equity > 1000);
  assert.deepEqual(r.store.db.prepare("SELECT payload, hash FROM ledger_entries WHERE kind='decision'").all(), before, "decisions unchanged");
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE kind='outcome'").get().n, 3);
  assert.equal(r.ledger.verify().ok, true);
});

test("engine: a retried bar close cannot trigger twice (deterministic decision ids)", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const again = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.ok(again.results.every(x => x.duplicate === true));
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM paper_positions").get().n, 3);
});

test("engine: a stop gapped through fills at the worse trade price, not at the stop", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  r.trade(64000, 2000); r.engine.manage();
  const p = pos(r.store, "balanced");
  assert.equal(p.exit_reason, "stop"); assert.ok(Math.abs(p.exit_price - 64000 * (1 - 0.0002)) < 1e-6, String(p.exit_price));
});

test("engine: a trade-feed gap while open makes the outcome UNEVALUABLE (kept, but excluded from performance)", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  r.store.addGap(ID, "trade", CLOSE + 4000, CLOSE + 9000, "ws_disconnect");
  r.trade(64590, 10000); r.engine.manage();
  const p = pos(r.store, "balanced");
  assert.equal(p.evaluable, 0); assert.match(p.note, /gap/);
  const o = JSON.parse(r.store.db.prepare("SELECT payload FROM ledger_entries WHERE entry_id LIKE 'outcome:decision:balanced%'").get().payload);
  assert.equal(o.evaluable, false);
  assert.equal(r.engine.summary().find(x => x.analyst === "balanced").evaluable_closed, 0);
});

test("engine: time exit at the bid; funding charged at settlement while open", () => {
  const r = rig();
  r.store.enqueue({ type: "ticker", instrument_id: ID, exch_ts: CLOSE + 4 * 3600000 - 1000, recv_ts: CLOSE + 4 * 3600000 - 900, last: "64950", bid: "64949.9", ask: "64950",
    bid_sz: "1", ask_sz: "1", mark: "64951", index_px: "64952", funding_rate: "0.0005", next_funding_ts: CLOSE + 4 * 3600000, open_interest: "1", oi_unit: "base_coin",
    source: "test", schema_version: 1, quality: [] }); r.store.flush();
  r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  r.at(CLOSE + 4 * 3600000 + 1000); r.engine.manage();
  const f = pos(r.store, "balanced").funding;
  assert.ok(f < 0, "a long pays positive funding"); assert.ok(Math.abs(f + 0.0005 * Number(pos(r.store, "balanced").qty) * 64950) < 1e-9);
  assert.equal(pos(r.store, "risk_taker").exit_reason, "time_exit", "Risk Taker's 4h time exit falls at the same moment");
  r.at(CLOSE + 32 * BAR + 1); r.collector.latestTicker[ID] = { last: "64950", bid: "64940", ask: "64950", recv_ts: r.now() };
  r.engine.manage();
  const p = pos(r.store, "balanced");
  assert.equal(p.exit_reason, "time_exit"); assert.ok(p.funding < 0, "funding carried into the closed position"); assert.ok(Math.abs(p.exit_price - 64940 * (1 - 0.0002)) < 1e-6);
});

test("engine: kill switch rejects new setups but keeps managing open positions; state survives a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-eng-")), file = path.join(dir, "m.db");
  let r = rig({ file }); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  r.engine.setKillSwitch("all", true);
  r.store.close();
  r = rig({ file, t0: CLOSE + BAR + 3000, snap: snapOf({ instrument_id: ID, bar_close_ts: CLOSE + BAR }) });   // restart
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM paper_positions WHERE state='OPEN'").get().n, 3, "open positions survive the restart");
  assert.ok(r.engine.portfolio("balanced").kill_switch, "kill switch persisted");
  r.store.db.exec("DELETE FROM paper_positions WHERE analyst='balanced'");                      // free the coin for a new setup
  const out = r.engine.onBarClose(ID, CLOSE + BAR, CLOSE + BAR + 3000);
  const b = out.results.find(x => x.analyst === "balanced");
  assert.equal(b.code, "RISK_REJECTED"); assert.ok(b.reasons.includes("KILL_SWITCH"));
  r.trade(64590, 1000); r.engine.manage();
  assert.equal(pos(r.store, "risk_taker").exit_reason, "stop", "existing positions still managed under the kill switch");
  r.store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("engine: daily loss persists across a restart and suspends new setups until the next UTC day", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-day-")), file = path.join(dir, "m.db");
  let r = rig({ file });
  r.store.db.prepare("UPDATE paper_portfolios SET equity=975 WHERE analyst='balanced'").run();  // -2.5% realised today
  r.store.close();
  r = rig({ file, t0: CLOSE + 3000 });
  assert.ok(r.engine.onBarClose(ID, CLOSE, CLOSE + 3000).results.find(x => x.analyst === "balanced").reasons.includes("DAILY_LOSS_SUSPENDED"));
  r.at(Date.UTC(2026, 10, 17, 0, 0, 5)); r.engine.rollDay();
  assert.equal(r.engine.portfolio("balanced").day.start_equity, 975, "new UTC day starts from the current equity");
  r.store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("engine: tick() decides once per bar, only after the start, and never on bars that closed before start", () => {
  const r = rig({ t0: CLOSE + 10000 });
  r.engine.tick(); assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM ledger_entries").get().n, 0, "bar closed before start: no decision");
  r.at(CLOSE + BAR + 61000); r.setSnap(snapOf({ bar_close_ts: CLOSE + BAR }));
  r.engine.tick(); r.engine.tick();
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE kind='decision'").get().n, 3, "one decision per analyst for the new bar");
});
