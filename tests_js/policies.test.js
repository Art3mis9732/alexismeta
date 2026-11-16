"use strict";
/* Evidence snapshot + analyst policy tests. Scenarios S1-S8 were written in devdocs/roadmap.md BEFORE the policies.
 * Candle series below are SYNTHETIC (seeded random walk) and exist only to exercise the builder's rules. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, ANALYSTS } = require("../server/policies");
const { buildFromInputs, BAR } = require("../server/evidence");

// ---------------------------------------------------------------- policy scenarios
const base = (o = {}) => ({ instrument_id: "bitget:perp:BTCUSDT", bar_close_ts: Date.UTC(2026, 10, 16, 9), hash: "h", missing: [],
  health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
  trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.5, bid: 64899.9, ask: 64900,
  depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, triggers: [], ...o });
const T = (code, dir, stop) => ({ code, name: code, dir, stop, level: null });
const run = s => Object.fromEntries(ANALYSTS.map(a => [a, decide(a, s)]));
const intents = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.intent + (v.intent === "OPEN_LONG" || v.intent === "OPEN_SHORT" ? "" : ":" + v.code)]));

test("S1 breakout in a hot market: Risk Taker and Balanced long, Defensive waits", () => {
  const r = intents(run(base({ atr_pctile: 0.85, triggers: [T("BO_UP", 1, 64700)] })));
  assert.deepEqual(r, { risk_taker: "OPEN_LONG", balanced: "OPEN_LONG", defensive: "WAIT:RAW_BREAKOUT_NOT_ACCEPTED" });
});
test("S2 low-volume breakout: only Risk Taker accepts incomplete confirmation", () => {
  assert.deepEqual(intents(run(base({ triggers: [T("BO_UP_WEAK", 1, 64700)] }))), { risk_taker: "OPEN_LONG", balanced: "WAIT:NO_TRIGGER", defensive: "WAIT:RAW_BREAKOUT_NOT_ACCEPTED" });
});
test("S3 clean retest: all three long (agreement is NOT independent confirmation: same snapshot)", () => {
  const r = run(base({ triggers: [T("RETEST_UP", 1, 64600)] }));
  assert.deepEqual(intents(r), { risk_taker: "OPEN_LONG", balanced: "OPEN_LONG", defensive: "OPEN_LONG" });
  assert.equal(new Set(Object.values(r).map(x => x.evidence_hash)).size, 1);
  assert.equal(r.risk_taker.setup.rr, 2); assert.equal(r.balanced.setup.rr, 1.5);
  assert.ok(r.defensive.setup.entry_reference - r.defensive.setup.stop >= 120 - 1e-9, "Defensive min stop 1 ATR");
  for (const x of Object.values(r)) { assert.equal(x.score, null); assert.equal(x.setup.expires_ts, x.bar_close_ts + BAR); }
});
test("S4 flat trend + failed breakdown in calm volatility: only Risk Taker's explicit reclaim rule trades", () => {
  assert.deepEqual(intents(run(base({ trend_1h: 0, above_vwap: false, atr_pctile: 0.3, triggers: [T("FAIL_DN", 1, 64650)] }))),
    { risk_taker: "OPEN_LONG", balanced: "NO_TRADE:NO_TREND", defensive: "NO_TRADE:NO_TREND" });
  assert.equal(decide("risk_taker", base({ trend_1h: 0, atr_pctile: 0.7, triggers: [T("FAIL_DN", 1, 64650)] })).code, "NO_TREND", "reclaim only when calm");
});
test("S5/S6 stale feed or invalid book: everyone NO_TRADE with the same reason", () => {
  const s5 = run(base({ triggers: [T("RETEST_UP", 1, 64600)], health: { ticker: "STALE", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" } }));
  assert.ok(Object.values(s5).every(x => x.intent === "NO_TRADE" && x.code === "DATA_STALE"));
  const s6 = run(base({ triggers: [T("RETEST_UP", 1, 64600)], book_state: "INVALID" }));
  assert.ok(Object.values(s6).every(x => x.intent === "NO_TRADE" && x.code === "BOOK_INVALID"));
  const gap = run(base({ triggers: [T("RETEST_UP", 1, 64600)], coverage_complete: false, coverage_reasons: ["gap_in_window"] }));
  assert.ok(Object.values(gap).every(x => x.code === "COVERAGE_GAP"));
  const miss = run(base({ missing: ["candles: gap after ..."] }));
  assert.ok(Object.values(miss).every(x => x.code === "DATA_MISSING"));
});
test("S7 wider spread: limits 5 / 3 / 1.5 bps separate the analysts", () => {
  assert.deepEqual(intents(run(base({ spread_bps: 2.5, triggers: [T("RETEST_UP", 1, 64600)] }))), { risk_taker: "OPEN_LONG", balanced: "OPEN_LONG", defensive: "NO_TRADE:SPREAD" });
  assert.deepEqual(intents(run(base({ spread_bps: 4, triggers: [T("RETEST_UP", 1, 64600)] }))), { risk_taker: "OPEN_LONG", balanced: "NO_TRADE:SPREAD", defensive: "NO_TRADE:SPREAD" });
});
test("policies: no exit intent without a position; open position -> WAIT; cooldown; trend/VWAP disagreement; shorts mirror longs", () => {
  const s = base({ triggers: [T("RETEST_UP", 1, 64600)] });
  for (const a of ANALYSTS) {
    assert.equal(decide(a, s, { position_open: true }).code, "POSITION_OPEN");
    assert.equal(decide(a, s, { cooldown_until: s.bar_close_ts + 1 }).code, "COOLDOWN");
    assert.ok(!/CLOSE|REDUCE/.test(decide(a, s).intent));
  }
  assert.equal(decide("balanced", base({ above_vwap: false, triggers: [T("RETEST_UP", 1, 64600)] })).code, "TREND_VWAP_DISAGREE");
  const sh = decide("balanced", base({ trend_1h: -1, above_vwap: false, triggers: [T("RETEST_DN", -1, 65200)] }));
  assert.equal(sh.intent, "OPEN_SHORT"); assert.equal(sh.setup.entry_reference, 64899.9, "a sell gets the bid");
  assert.ok(sh.setup.stop > sh.setup.entry_reference && sh.setup.target < sh.setup.entry_reference);
  assert.equal(decide("balanced", base({ triggers: [T("RETEST_UP", 1, 64950)] })).code, "INVALIDATED", "price already through the stop");
  assert.equal(decide("defensive", base({ depth_10bps: { bid: 10000, ask: 900000 }, triggers: [T("RETEST_UP", 1, 64600)] })).code, "DEPTH");
  assert.equal(decide("defensive", base({ change_24h: -0.01, triggers: [T("RETEST_UP", 1, 64600)] })).code, "DAY_DISAGREES");
  assert.ok(decide("balanced", base({ change_24h: -0.01, triggers: [T("RETEST_UP", 1, 64600)] })).setup.contradicting.length >= 1, "contradicting evidence recorded");
});

// ---------------------------------------------------------------- evidence builder (synthetic candles)
function synth(n, end, seed = 7) {
  let x = seed, p = 65000; const rows = [];
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + (rnd() - 0.5) * 0.004), h = Math.max(o, c) * (1 + rnd() * 0.001), l = Math.min(o, c) * (1 - rnd() * 0.001);
    rows.push({ open_ts: end - (n - i) * BAR, o: o.toFixed(1), h: h.toFixed(1), l: l.toFixed(1), c: c.toFixed(1), base_vol: (10 + rnd() * 50).toFixed(4), final: 1 }); p = c;
  }
  return rows;
}
const close = Date.UTC(2026, 10, 16, 9), dec = close + 3000;
const tk = { recv_ts: close + 2000, bid: "64899.9", ask: "64900.0", last: "64900", mark: "64901", index_px: "64903", funding_rate: null };
const book = { state: "VALID", recv_ts: close + 2500, bids: [["64899.9", "2"], ["64880", "1"], ["64000", "50"]], asks: [["64900", "1.5"], ["64930", "3"]] };
const H = { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" };
const COV = [{ complete: true, reasons: [] }];
const bi = (o = {}) => buildFromInputs({ instrumentId: "bitget:perp:BTCUSDT", barCloseTs: close, decisionTs: dec, candles: synth(400, close), ticker: tk, book, health: H, coverage: COV, ...o });

test("evidence: deterministic hash, features present, depth from the full book within 10 bps, missing funding stays null", () => {
  const a = bi(), b = bi();
  assert.equal(a.hash, b.hash); assert.deepEqual(a.missing, []);
  assert.ok([-1, 0, 1].includes(a.trend_1h)); assert.ok(a.atr > 0 && a.atr_pctile >= 0 && a.atr_pctile <= 1);
  assert.equal(a.funding_rate, null);
  assert.equal(Math.round(a.depth_10bps.bid), Math.round(64899.9 * 2 + 64880 * 1), "the 64000 level is > 10 bps away");
  assert.ok(Math.abs(a.spread_bps - 0.0154) < 0.001);
  assert.equal(a.data_cutoff_ts, close + 2500);
  assert.notEqual(bi({ ticker: { ...tk, bid: "64899.8" } }).hash, a.hash, "any input change changes the hash");
});

test("evidence: gaps, non-final bars, a missing last bar, too little history, or post-decision data are reported as missing", () => {
  const rows = synth(400, close); rows.splice(200, 1);
  assert.match(bi({ candles: rows }).missing.join(), /gap after/);
  const nf = synth(400, close); nf[399].final = 0;
  assert.match(bi({ candles: nf }).missing.join(), /non-final/);
  assert.match(bi({ candles: synth(400, close - BAR) }).missing.join(), /does not close at the decision bar close/);
  assert.match(bi({ candles: synth(100, close) }).missing.join(), /candles: 100 < 300/);
  assert.match(bi({ ticker: { ...tk, recv_ts: dec + 1 } }).missing.join(), /ticker: none at decision time/, "a ticker received after the decision is not usable");
  assert.match(bi({ book: { ...book, recv_ts: dec + 10 } }).missing.join(), /data_cutoff after decision time/);
  assert.equal(bi({ coverage: [{ complete: false, reasons: ["gap_in_window"] }] }).coverage_complete, false);
  assert.equal(bi({ book: { ...book, state: "INVALID" } }).depth_10bps, null, "no depth from an invalid book");
});

test("evidence: a later (forming) bar in the store is ignored; the snapshot for a bar close is unchanged by later data", () => {
  const { Store } = require("../server/store");
  const { buildLive } = require("../server/evidence");
  const id = "bitget:perp:BTCUSDT";
  const mk = () => { const st = new Store(":memory:", { now: () => dec });
    for (const r of synth(400, close)) st.enqueue({ type: "candle", instrument_id: id, interval: "15m", open_ts: r.open_ts, o: r.o, h: r.h, l: r.l, c: r.c,
      base_vol: r.base_vol, quote_vol: null, final: 1, exch_ts: close, recv_ts: close, source: "synthetic-test", schema_version: 1, quality: [] });
    st.flush(); return st; };
  const coll = { latestTicker: { [id]: tk }, books: { [id]: { state: "VALID", recvTs: book.recv_ts, top: () => ({ bids: book.bids, asks: book.asks }) } } };
  const health = { snapshot: () => ({ feeds: Object.entries(H).map(([kind, state]) => ({ feed: id + "|" + kind, kind, state })) }) };
  const a = mk(), b = mk();
  b.enqueue({ type: "candle", instrument_id: id, interval: "15m", open_ts: close, o: "1", h: "999999", l: "1", c: "999999", base_vol: "1", quote_vol: null,
    final: 0, exch_ts: close + 60000, recv_ts: close + 60000, source: "synthetic-test", schema_version: 1, quality: [] }); b.flush();
  const sa = buildLive({ store: a, collector: coll, health, instrumentId: id, barCloseTs: close, decisionTs: dec });
  const sb = buildLive({ store: b, collector: coll, health, instrumentId: id, barCloseTs: close, decisionTs: dec });
  assert.equal(sa.candles.last_open + BAR, close); assert.equal(sb.candles.last_open + BAR, close);
  assert.equal(sa.hash, sb.hash, "the forming bar after the decision bar must not influence the snapshot");
  assert.equal(sa.coverage_complete, false, "nothing was observed live in this store, so coverage is incomplete");
  a.close(); b.close();
});

test("evidence: coverage is required for what v1 consumes (ticker + book, last 60 s); an older 1 s disconnect no longer blocks", () => {
  const { Store } = require("../server/store");
  const { buildLive, COVERAGE } = require("../server/evidence");
  const id = "bitget:perp:BTCUSDT", st = new Store(":memory:", { now: () => dec });
  for (const r of synth(400, close)) st.enqueue({ type: "candle", instrument_id: id, interval: "15m", open_ts: r.open_ts, o: r.o, h: r.h, l: r.l, c: r.c,
    base_vol: r.base_vol, quote_vol: null, final: 1, exch_ts: close, recv_ts: close, source: "synthetic-test", schema_version: 1, quality: [] });
  for (const kind of ["ticker", "book_top"]) st.enqueue(kind === "ticker"
    ? { type: "ticker", instrument_id: id, exch_ts: close - 3600000, recv_ts: close - 3600000, last: "1", bid: "1", ask: "1", bid_sz: null, ask_sz: null, mark: null, index_px: null, funding_rate: null, next_funding_ts: null, open_interest: null, oi_unit: "base_coin", source: "t", schema_version: 1, quality: [] }
    : { type: "book_top", instrument_id: id, exch_ts: close - 3600000, recv_ts: close - 3600000, seq: 1, levels: 1, bids_json: "[]", asks_json: "[]", source: "t", schema_version: 1, quality: [] });
  st.flush();
  const coll = { latestTicker: { [id]: tk }, books: { [id]: { state: "VALID", recvTs: book.recv_ts, top: () => ({ bids: book.bids, asks: book.asks }) } } };
  const health = { snapshot: () => ({ feeds: Object.entries(H).map(([kind, state]) => ({ feed: id + "|" + kind, kind, state })) }) };
  for (const k of ["trade", "ticker", "book"]) st.addGap(id, k, dec - 8 * 60000, dec - 8 * 60000 + 1000, "ws_disconnect");   // 8 min ago, 1 s
  assert.equal(buildLive({ store: st, collector: coll, health, instrumentId: id, barCloseTs: close, decisionTs: dec }).coverage_complete, true);
  st.addGap(id, "book", dec - 30000, dec - 29000, "ws_disconnect");                                                          // inside the last 60 s
  const s2 = buildLive({ store: st, collector: coll, health, instrumentId: id, barCloseTs: close, decisionTs: dec });
  assert.equal(s2.coverage_complete, false); assert.ok(s2.coverage_reasons.includes("gap_in_window"));
  assert.deepEqual(COVERAGE, { ticker_book_ms: 60000, trade_ms: 0 });
  st.close();
});

test("explain(): predicate diagnostics agree with decide() on every scenario (all predicates pass <=> an OPEN intent)", () => {
  const { explain, registry } = require("../server/policies");
  const cases = [base({ atr_pctile: 0.85, triggers: [T("BO_UP", 1, 64700)] }), base({ triggers: [T("BO_UP_WEAK", 1, 64700)] }), base({ triggers: [T("RETEST_UP", 1, 64600)] }),
    base({ trend_1h: 0, above_vwap: false, atr_pctile: 0.3, triggers: [T("FAIL_DN", 1, 64650)] }), base({ spread_bps: 2.5, triggers: [T("RETEST_UP", 1, 64600)] }), base({}),
    base({ book_state: "INVALID", triggers: [T("RETEST_UP", 1, 64600)] }), base({ trend_1h: -1, above_vwap: false, triggers: [T("RETEST_DN", -1, 65200)] }), base({ above_vwap: false, triggers: [T("RETEST_UP", 1, 64600)] }),
    base({ change_24h: -0.01, triggers: [T("RETEST_UP", 1, 64600)] }), base({ depth_10bps: { bid: 10, ask: 10 }, triggers: [T("RETEST_UP", 1, 64600)] })];
  for (const s of cases) for (const a of ANALYSTS) {
    const d = decide(a, s), e = explain(a, s), opens = d.intent === "OPEN_LONG" || d.intent === "OPEN_SHORT";
    assert.equal(e.all_pass, opens, `${a}: decide=${d.intent}/${d.code} but explain.blocking=${e.blocking}`);
    if (!opens) assert.ok(e.blocking, "a blocked decision names the blocking predicate");
  }
  const reg = registry();
  assert.equal(reg.length, 3); assert.ok(reg.every(r => r.type === "DETERMINISTIC" && r.training === "NOT_APPLICABLE" && r.edge === "NOT_DEMONSTRATED"));
});
