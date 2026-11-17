"use strict";
/* Stress policy x independent risk gate x paper engine. The stress module may only BLOCK NEW entries; open positions and accounting are untouched. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Store } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const risk = require("../server/risk");
const S = require("../server/stress");
const { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const ID = "bitget:perp:BTCUSDT", CLOSE = Date.UTC(2026, 10, 16, 9);
const T = (code, dir, stop) => ({ code, name: code, dir, stop, level: null });
const snapOf = (o = {}) => ({ instrument_id: ID, bar_close_ts: CLOSE, decision_ts: CLOSE + 3000, hash: "snap-" + JSON.stringify(o).length, missing: [],
  health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
  trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.02, bid: 64899.9, ask: 64900,
  depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, data_cutoff_ts: CLOSE + 2000, triggers: [T("RETEST_UP", 1, 64600)], ...o });

/** a stress source whose state the test controls; gate() is the REAL pure policy (entryGate), so policy and engine are tested together */
function stressSrc(mode, states, now) { return { gate: (id, t) => S.entryGate({ states: typeof states === "function" ? states() : states, instrumentId: id, nowTs: t, mode }), calls: 0 }; }
const st = (sev, over = {}, t = CLOSE + 3000) => ({ severity: sev, quality: "VALID", last_eval_ts: t, valid_since_ts: t - 10 * 60000, ...over });

function rig({ mode = "ENFORCE", state = () => ({ [ID]: st("NORMAL") }), withStress = true } = {}) {
  let t = CLOSE + 3000; const now = () => t, store = new Store(":memory:", { now }), ledger = new Ledger(store, { now, codeRev: "test" });
  store.upsertInstrument(fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", t));
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: { [ID]: { last: "64900", bid: "64899.9", ask: "64900", next_funding_ts: CLOSE + 4 * 3600000, recv_ts: t } }, books: {} };
  const health = { snapshot: () => ({ feeds: [] }) };
  let cur = snapOf(), n = 0, calls = 0;
  const stress = withStress ? { gate: (id, tt) => { calls++; return S.entryGate({ states: state(), instrumentId: id, nowTs: tt, mode }); } } : null;
  const engine = new PaperEngine({ store, ledger, collector, health, now, buildSnapshot: () => cur, stress });
  const trade = (price, dt) => { t += dt; store.enqueue({ type: "trade", instrument_id: ID, trade_id: "9" + String(++n).padStart(18, "0"), exch_ts: t, recv_ts: t + 5, price: String(price), size: "0.01", venue_side: "buy", source: "test", schema_version: 1, quality: [] }); store.flush(); };
  return { store, ledger, engine, trade, now, calls: () => calls, setSnap: s => { cur = s; }, at: v => { t = v; } };
}
const riskRows = r => r.store.db.prepare("SELECT versions, payload FROM ledger_entries WHERE kind='status' AND entry_id LIKE 'risk:%' ORDER BY seq").all().map(x => ({ v: JSON.parse(x.versions), p: JSON.parse(x.payload) }));
const nPos = r => r.store.db.prepare("SELECT COUNT(*) n FROM paper_positions").get().n;

test("no stress argument: risk.evaluate is unchanged (and the engine without a monitor records no stress fields)", () => {
  const r = rig({ withStress: false }); const out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(out.results.map(x => x.code), ["OPENED", "OPENED", "OPENED"]);
  assert.ok(riskRows(r).every(x => x.p.stress === undefined && x.v.stress === undefined));
  const e = risk.evaluate({ analyst: "balanced", setup: { intent: "OPEN_LONG", stop: 64600 }, snapshot: snapOf(), portfolio: { analyst: "balanced", equity: 1000, peak_equity: 1000, day: { start_ts: 0, start_equity: 1000 }, positions: [], kill_switch: false }, instrument: { min_qty: "0.0001", qty_step: "0.0001", min_notional: "5" } });
  assert.equal(e.approved, true); assert.equal(e.checks.stress, undefined);
});

test("ENFORCE + CRITICAL: new entries are rejected by the risk gate, the policy version and verdict are recorded in the ledger, the ledger stays valid", () => {
  const r = rig({ state: () => ({ [ID]: st("CRITICAL") }) }); const out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(out.results.map(x => x.code), ["RISK_REJECTED", "RISK_REJECTED", "RISK_REJECTED"]);
  assert.ok(out.results.every(x => x.reasons.includes("STRESS_CRITICAL_MARKET")));
  assert.equal(nPos(r), 0);
  for (const x of riskRows(r)) { assert.equal(x.p.state, "RISK_REJECTED"); assert.equal(x.p.stress.policy, "stress-policy-v1"); assert.equal(x.p.stress.mode, "ENFORCE"); assert.equal(x.p.stress.would_block, true); assert.equal(x.v.stress, "stress-policy-v1/ENFORCE"); }
  assert.equal(r.ledger.verify().ok, true);
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE kind='decision'").get().n, 3, "the analysts still decided (and are recorded); only the entry was refused");
});

test("SHADOW + CRITICAL: the verdict is recorded as would_block but nothing is blocked; the entries open exactly as without stress", () => {
  const r = rig({ mode: "SHADOW", state: () => ({ [ID]: st("CRITICAL") }) }); const out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(out.results.map(x => x.code), ["OPENED", "OPENED", "OPENED"]);
  for (const x of riskRows(r)) { assert.equal(x.p.state, "RISK_APPROVED"); assert.equal(x.p.stress.would_block, true); assert.equal(x.p.stress.enforced, false); assert.equal(x.p.stress.mode, "SHADOW"); }
  const clean = rig({ withStress: false }); clean.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const q = rr => rr.store.db.prepare("SELECT analyst, qty, entry FROM paper_positions ORDER BY analyst").all();
  assert.deepEqual(q(r), q(clean), "sizing and fills are identical with and without a SHADOW monitor");
});

test("scope: HIGH_STRESS on one asset blocks that asset only; UNRELIABLE data, a missing state and a stale monitor block; ELEVATED only warns", () => {
  const ETH = "bitget:perp:ETHUSDT";
  let r = rig({ state: () => ({ [ID]: st("ELEVATED"), [ETH]: st("NORMAL") }) });
  assert.deepEqual(r.engine.onBarClose(ID, CLOSE, CLOSE + 3000).results.map(x => x.code), ["OPENED", "OPENED", "OPENED"], "ELEVATED is a warning only in policy v1");
  assert.ok(riskRows(r).every(x => /warning only/.test(x.p.stress.detail)));
  r = rig({ state: () => ({ [ID]: st("HIGH_STRESS"), [ETH]: st("NORMAL") }) });
  assert.ok(r.engine.onBarClose(ID, CLOSE, CLOSE + 3000).results.every(x => x.reasons.includes("STRESS_HIGH_ASSET")));
  for (const [name, state, code] of [["unreliable", () => ({ [ID]: st("NORMAL", { quality: "UNRELIABLE" }) }), "STRESS_DATA_UNRELIABLE"], ["no state", () => ({}), "STRESS_UNKNOWN"],
    ["stale monitor", () => ({ [ID]: st("NORMAL", { last_eval_ts: CLOSE - 120000 }) }), "STRESS_MONITOR_STALE"], ["recovery window", () => ({ [ID]: st("NORMAL", { valid_since_ts: CLOSE }) }), "STRESS_RECOVERY_WINDOW"]]) {
    r = rig({ state }); const out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
    assert.ok(out.results.every(x => x.reasons && x.reasons.includes(code)), name + " -> " + code);
  }
});

test("open positions are never touched by a halt: stops, targets, P&L and accounting continue while new entries are blocked", () => {
  let level = "NORMAL"; const r = rig({ state: () => ({ [ID]: st(level, {}, r_now()) }) });
  function r_now() { return r ? r.now() : CLOSE + 3000; }
  r.engine.onBarClose(ID, CLOSE, CLOSE + 3000); assert.equal(nPos(r), 3);
  const entries = r.store.db.prepare("SELECT analyst, entry, qty, stop FROM paper_positions ORDER BY analyst").all();
  level = "CRITICAL";                                                                      // the market turns CRITICAL while three positions are open
  const next = CLOSE + 900000; r.at(next + 3000); r.setSnap(snapOf({ bar_close_ts: next, decision_ts: next + 3000, hash: "snap-b", triggers: [T("RETEST_UP", 1, 64600)] }));
  r.trade(64900, 1000);
  const out = r.engine.onBarClose(ID, next, next + 3000);
  assert.ok(out.results.every(x => x.code !== "OPENED"), "no new entry during the halt");
  assert.equal(nPos(r), 3, "and no position was force-closed or reduced by the halt");
  assert.deepEqual(r.store.db.prepare("SELECT analyst, entry, qty, stop FROM paper_positions ORDER BY analyst").all(), entries, "entries, sizes and stops are unchanged");
  r.trade(64590, 1000); r.engine.manage();                                                 // the market keeps falling: the stop still fills normally
  const rt = r.store.db.prepare("SELECT * FROM paper_positions WHERE analyst='risk_taker'").get();
  assert.equal(rt.exit_reason, "stop"); assert.ok(rt.pnl < 0, "loss is booked as usual");
  const eq = r.store.db.prepare("SELECT equity FROM paper_portfolios WHERE analyst='risk_taker'").get().equity; assert.ok(eq < 1000);
  assert.equal(r.ledger.verify().ok, true);
});

test("the gate is read AT each authorisation, never cached from an earlier signal: a restriction that appears between two analysts' authorisations blocks the second", () => {
  let reads = 0;                                                                           // the market turns CRITICAL after the first authorisation in the same bar
  const r = rig({ state: () => ({ [ID]: st(++reads === 1 ? "NORMAL" : "CRITICAL") }) });
  const out = r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const codes = out.results.map(x => x.code);
  assert.equal(codes.filter(c => c === "OPENED").length, 1, "only the authorisation that happened before the restriction opened");
  assert.equal(codes.filter(c => c === "RISK_REJECTED").length, 2);
  assert.equal(r.calls(), 3, "one fresh read per analyst that wanted to open");
  assert.equal(nPos(r), 1);
});

test("recovery: after the restriction clears and data has been usable for 5 minutes, entries are allowed again", () => {
  const t = CLOSE + 3000;
  assert.equal(S.entryGate({ states: { [ID]: st("NORMAL", { valid_since_ts: t - 4 * 60000 }) }, instrumentId: ID, nowTs: t, mode: "ENFORCE" }).code, "STRESS_RECOVERY_WINDOW");
  assert.equal(S.entryGate({ states: { [ID]: st("NORMAL", { valid_since_ts: t - 6 * 60000 }) }, instrumentId: ID, nowTs: t, mode: "ENFORCE" }).would_block, false);
  assert.equal(S.entryGate({ states: { [ID]: st("NORMAL", { quality: "DEGRADED", valid_since_ts: t - 6 * 60000 }) }, instrumentId: ID, nowTs: t, mode: "ENFORCE" }).would_block, false, "DEGRADED (liquidity warming up) is usable");
});
