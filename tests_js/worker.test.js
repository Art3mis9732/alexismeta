"use strict";
/* Worker (server/) tests. Deterministic: no network, fixtures captured from the real Bitget feed on 2026-11-16.
 *   node --test tests_js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../server/schema");
const { fromBitgetContract, assertClass } = require("../server/instruments");
const { OrderBook } = require("../server/book");
const { Store } = require("../server/store");
const { Health } = require("../server/health");
const { BitgetRest, WsSupervisor, backoffMs } = require("../server/adapters/bitget");
const { BitgetCollector } = require("../server/collector");
const { createServer } = require("../server/http");
const { buildApi } = require("../server/main");
const { makeClock, FakeWS } = require("./helpers");

const FX = path.join(__dirname, "fixtures", "bitget");
const CAP = JSON.parse(fs.readFileSync(path.join(FX, "ws_capture.json"), "utf8"));
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(FX, "contracts.json"), "utf8"));
const REST_CANDLES = JSON.parse(fs.readFileSync(path.join(FX, "rest_candles_1m.json"), "utf8"));
const BTC = "bitget:perp:BTCUSDT";
const of = (ch, action) => CAP.filter(m => m.data && m.arg && m.arg.channel === ch && (!action || m.action === action));
const clone = o => JSON.parse(JSON.stringify(o));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-test-"));

// ---------------------------------------------------------------- instruments
test("instrument identity comes from the contract row: BTCUSDT is a linear USDT-settled perpetual", () => {
  const row = CONTRACTS.data.find(c => c.symbol === "BTCUSDT");
  const ins = fromBitgetContract(row, "USDT-FUTURES", 1);
  assert.equal(ins.instrument_id, BTC);
  assert.equal(ins.inst_class, "perpetual"); assert.equal(ins.linear, 1); assert.equal(ins.settle, "USDT");
  assert.equal(ins.base, "BTC"); assert.equal(ins.quote, "USDT"); assert.equal(ins.qty_step, row.sizeMultiplier); assert.equal(ins.min_qty, row.minTradeNum);
  assert.throws(() => assertClass(ins, "spot"), /expected spot/);
  assert.equal(fromBitgetContract({ ...row, symbolType: "delivery" }, "USDT-FUTURES", 1).inst_class, "dated_future");
  assert.throws(() => fromBitgetContract({ ...row, symbolType: "weird" }, "USDT-FUTURES", 1), /unknown symbolType/);
  assert.throws(() => fromBitgetContract({ ...row, minTradeNum: "abc" }, "USDT-FUTURES", 1), /not a decimal/);
});

// ---------------------------------------------------------------- schema
test("real captured trade/ticker/candle/book messages normalise with exact decimal strings and three timestamps", () => {
  const tm = of("trade", "snapshot")[0], recv = tm.ts + 40;
  const tr = S.bitgetTrades(tm, BTC, recv);
  assert.ok(tr.ok); assert.ok(tr.events.length > 0);
  const e = tr.events[0];
  assert.equal(typeof e.price, "string"); assert.equal(e.price, tm.data[0].price);
  assert.equal(e.trade_id, tm.data[0].tradeId); assert.equal(e.recv_ts, recv); assert.ok(e.exch_ts <= recv);
  assert.deepEqual(e.quality, ["aggressor_semantics_unverified"]);

  const tk = S.bitgetTicker(of("ticker")[0], BTC, of("ticker")[0].ts + 10);
  assert.ok(tk.ok);
  const t = tk.events[0];
  assert.notEqual(t.last, null); assert.notEqual(t.mark, null); assert.notEqual(t.index_px, null);
  assert.equal(t.oi_unit, "base_coin"); assert.deepEqual(t.quality, []);

  const cm = of("candle1m", "snapshot")[0], c = S.bitgetWsCandles(cm, BTC, "1m", cm.ts + 5);
  assert.ok(c.ok);
  const forming = c.events.filter(x => x.final === 0);
  assert.equal(forming.length, 1, "exactly one forming candle in a snapshot");
  assert.equal(forming[0].open_ts, Math.max(...c.events.map(x => x.open_ts)));

  const bk = S.bitgetBook(of("books", "snapshot")[0], BTC, of("books", "snapshot")[0].ts + 5);
  assert.ok(bk.ok); assert.equal(bk.events[0].action, "snapshot");
});

test("missing funding / OI become null with a quality flag, never 0", () => {
  const m = clone(of("ticker")[0]); delete m.data[0].fundingRate; m.data[0].holdingAmount = "";
  const t = S.bitgetTicker(m, BTC, m.ts + 1).events[0];
  assert.equal(t.funding_rate, null); assert.equal(t.open_interest, null);
  assert.ok(t.quality.includes("missing_funding_rate")); assert.ok(t.quality.includes("missing_open_interest"));
});

test("malformed messages are rejected with a reason (to be quarantined)", () => {
  const tm = of("trade", "snapshot")[0], recv = tm.ts + 1;
  const bad = f => { const m = clone(tm); f(m.data[0]); return S.bitgetTrades(m, BTC, recv); };
  assert.equal(bad(d => d.price = "-1").ok, false);
  assert.equal(bad(d => d.price = "1e5").ok, false);
  assert.equal(bad(d => delete d.tradeId).ok, false);
  assert.equal(bad(d => d.side = "long").ok, false);
  assert.equal(bad(d => d.ts = String(Date.UTC(2010, 0, 1))).ok, false);
  const cm = clone(of("candle1m", "snapshot")[0]); cm.data[0][2] = "1"; // high below low
  assert.match(S.bitgetWsCandles(cm, BTC, "1m", cm.ts + 1).reason, /high\/low/);
  const bm = clone(of("books", "snapshot")[0]); bm.data[0].seq = "x";
  assert.equal(S.bitgetBook(bm, BTC, bm.ts + 1).ok, false);
});

test("REST candles use the exchange requestTime to decide finality", () => {
  const r = S.bitgetRestCandles(REST_CANDLES, BTC, "1m", REST_CANDLES.requestTime + 100);
  assert.ok(r.ok);
  for (const e of r.events) assert.equal(e.final, e.open_ts + 60000 <= REST_CANDLES.requestTime ? 1 : 0);
  assert.ok(r.events.every(e => e.source === "bitget_rest_v2"));
});

// ---------------------------------------------------------------- order book
const bookEvents = () => of("books").map(m => S.bitgetBook(m, BTC, m.ts + 5).events[0]);

test("book: real snapshot + chained updates stay VALID and uncrossed", () => {
  const b = new OrderBook(BTC);
  for (const e of bookEvents()) assert.ok(b.apply(e).ok, "apply " + e.action + " " + e.seq);
  const s = b.summary();
  assert.equal(s.state, "VALID"); assert.ok(Number(s.best_bid) < Number(s.best_ask));
  assert.equal(b.stats.updates, bookEvents().length - 1);
});

test("book: a sequence gap invalidates, blocks further updates, and only a new snapshot restores it", () => {
  const ev = bookEvents(), b = new OrderBook(BTC);
  b.apply(ev[0]); b.apply(ev[1]);
  const r = b.apply(ev[3]);                       // skipped ev[2]
  assert.equal(r.invalid, true); assert.match(r.reason, /seq_gap/);
  assert.equal(b.state, "INVALID"); assert.deepEqual(b.top(5), { bids: [], asks: [] });
  assert.equal(b.apply(ev[4]).ignored, true, "updates ignored while invalid");
  assert.ok(b.apply(ev[0]).ok); assert.equal(b.state, "VALID");
});

test("book: duplicate / late updates are ignored without invalidating", () => {
  const ev = bookEvents(), b = new OrderBook(BTC);
  b.apply(ev[0]); b.apply(ev[1]); b.apply(ev[2]);
  const r = b.apply(ev[1]);
  assert.equal(r.ignored, true); assert.equal(b.state, "VALID"); assert.equal(b.stats.duplicates, 1);
});

test("book: crossed, negative-size and unsorted books are invalid", () => {
  const snap = () => ({ action: "snapshot", seq: 10, pseq: 0, exch_ts: 1, recv_ts: 1, bids: [["100", "1"], ["99", "1"]], asks: [["101", "1"], ["102", "1"]] });
  let b = new OrderBook(BTC); b.apply(snap());
  assert.equal(b.apply({ action: "update", seq: 11, pseq: 10, exch_ts: 2, recv_ts: 2, bids: [["101.5", "1"]], asks: [] }).reason, "crossed");
  b = new OrderBook(BTC); b.apply(snap());
  assert.equal(b.apply({ action: "update", seq: 11, pseq: 10, exch_ts: 2, recv_ts: 2, bids: [["98", "-1"]], asks: [] }).reason, "negative_size");
  b = new OrderBook(BTC);
  assert.match(b.apply({ ...snap(), bids: [["99", "1"], ["100", "1"]] }).reason, /unsorted/);
  b = new OrderBook(BTC); b.apply(snap());
  assert.ok(b.apply({ action: "update", seq: 11, pseq: 10, exch_ts: 2, recv_ts: 2, bids: [["100", "0"]], asks: [] }).ok);
  assert.equal(b.summary().best_bid, "99", "size 0 deletes a level");
});

// ---------------------------------------------------------------- store
const trade = (id, ts, px = "100") => ({ type: "trade", instrument_id: BTC, trade_id: id, exch_ts: ts, recv_ts: ts + 5, price: px, size: "1", venue_side: "buy", source: "t", schema_version: 1, quality: [] });
const candle = (open, c, final, exch, src = "t") => ({ type: "candle", instrument_id: BTC, interval: "1m", open_ts: open, o: "100", h: "110", l: "90", c, base_vol: "1", quote_vol: null, final, exch_ts: exch, recv_ts: exch, source: src, schema_version: 1, quality: [] });

test("store: duplicate trades are written once (idempotent)", () => {
  const st = new Store(":memory:");
  st.enqueue(trade("1", 1000)); st.enqueue(trade("1", 1000)); st.enqueue(trade("2", 1001)); st.flush();
  st.enqueue(trade("1", 1000)); st.flush();
  assert.equal(st.count("trades"), 2); assert.equal(st.stats.unchanged.trade, 2);
  st.close();
});

test("store: out-of-order candles never replace a final candle with partial or older data", () => {
  const st = new Store(":memory:"), t0 = 60000 * 1000;
  st.enqueue(candle(t0, "101", 0, t0 + 10000)); st.flush();           // forming
  st.enqueue(candle(t0, "105", 1, t0 + 60000, "rest")); st.flush();   // final
  st.enqueue(candle(t0, "103", 0, t0 + 70000)); st.flush();           // late partial: ignored
  st.enqueue(candle(t0, "99", 1, t0 + 50000)); st.flush();            // older final: ignored
  let r = st.candles(BTC, "1m", 5)[0];
  assert.equal(r.c, "105"); assert.equal(r.final, 1); assert.equal(r.source, "rest");
  st.enqueue(candle(t0, "105", 1, t0 + 90000, "ws")); st.flush();     // identical final: no-op, provenance kept
  assert.equal(st.candles(BTC, "1m", 5)[0].source, "rest");
  st.enqueue(candle(t0, "106", 1, t0 + 95000, "ws")); st.flush();     // newer final with different values: correction
  r = st.candles(BTC, "1m", 5)[0]; assert.equal(r.c, "106"); assert.equal(r.source, "ws");
  st.close();
});

test("store: data survives a restart; migrations are idempotent", () => {
  const dir = tmpdir(), f = path.join(dir, "m.db");
  let st = new Store(f); st.enqueue(trade("7", 5000)); st.enqueue(candle(60000, "100", 1, 120000)); st.close();
  st = new Store(f);
  assert.equal(st.count("trades"), 1); assert.equal(st.count("candles"), 1);
  assert.equal(st.db.prepare("PRAGMA user_version").get().user_version, require("../server/store").MIGRATIONS.length);
  assert.equal(st.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(st.lastFinalCandleTs(BTC, "1m"), 60000);
  st.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("store: retention prunes only rows older than each window", () => {
  const now = Date.UTC(2026, 10, 16), st = new Store(":memory:", { now: () => now });
  st.enqueue(trade("old", now - 4 * 86400000)); st.enqueue(trade("new", now - 3600000)); st.flush();
  const r = st.prune(now);
  assert.equal(r.trades, 1); assert.equal(st.count("trades"), 1); assert.equal(st.trades(BTC, 5)[0].trade_id, "new");
  st.close();
});

test("store: bounded queue drops and records overflow instead of growing without limit", () => {
  const st = new Store(":memory:", { maxQueue: 2 });
  assert.equal(st.enqueue(trade("a", 1)), true); assert.equal(st.enqueue(trade("b", 2)), true); assert.equal(st.enqueue(trade("c", 3)), false);
  assert.equal(st.stats.dropped, 1); assert.equal(st.feedEvents(5)[0].event, "backpressure_drop");
  st.close();
});

test("store: online backup produces an intact copy", () => {
  const dir = tmpdir(), st = new Store(path.join(dir, "m.db"));
  st.enqueue(trade("1", 1000)); st.flush();
  const b = st.backup(path.join(dir, "backup", "m-copy.db"));
  assert.equal(b.integrity, "ok"); assert.throws(() => st.backup(b.file), /exists/);
  st.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- health
test("health: pongs never keep a feed HEALTHY; STALE / DISCONNECTED / RECOVERING are distinct", () => {
  const ck = makeClock(), h = new Health({ now: ck.now, graceMs: 15000 });
  h.register("f", "ticker");
  assert.equal(h.snapshot().feeds[0].state, "DISCONNECTED");
  h.onSocket("open"); assert.equal(h.snapshot().feeds[0].state, "RECOVERING");
  h.onData("f", ck.now()); assert.equal(h.snapshot().feeds[0].state, "HEALTHY");
  for (let i = 0; i < 12; i++) { ck.advance(1000); h.onFrame(); }            // only pongs for 12 s
  assert.equal(h.snapshot().feeds[0].state, "STALE", "ticker threshold is 10 s");
  h.onData("f", ck.now()); assert.equal(h.snapshot().feeds[0].state, "HEALTHY");
  h.onSocket("closed"); assert.equal(h.snapshot().feeds[0].state, "DISCONNECTED");
  h.onSocket("open"); assert.equal(h.snapshot().feeds[0].state, "RECOVERING", "needs fresh data after a reconnect");
  assert.equal(h.snapshot().socket.reconnects, 1);
  ck.advance(16000); assert.equal(h.snapshot().feeds[0].state, "STALE", "no data within the grace period");
});

// ---------------------------------------------------------------- WS supervisor
function makeSup(extra = {}) {
  FakeWS.reset();
  const ck = makeClock(), states = [], msgs = [];
  const sup = new WsSupervisor({ WebSocketImpl: FakeWS, url: "wss://x", now: ck.now, setTimer: ck.setTimer, clearTimer: ck.clearTimer, random: () => 1,
    subscriptions: [{ instType: "USDT-FUTURES", channel: "trade", instId: "BTCUSDT" }], onState: s => states.push(s), onMessage: m => msgs.push(m), ...extra });
  return { ck, sup, states, msgs };
}

test("supervisor: subscribes on open, pings, and resubscribes after every reconnect on a single socket", () => {
  const { ck, sup, states } = makeSup();
  sup.start(); const w1 = FakeWS.instances[0]; w1.open();
  assert.equal(w1.subs()[0].op, "subscribe");
  ck.advance(25000); assert.ok(w1.sent.includes("ping"));
  w1.msg("pong");
  w1.drop();
  assert.equal(FakeWS.instances.length, 1, "no immediate reconnect storm");
  ck.advance(1000);                                  // backoff attempt 0 with random=1 -> 1000 ms
  assert.equal(FakeWS.instances.length, 2);
  const w2 = FakeWS.instances[1]; w2.open();
  assert.equal(w2.subs()[0].op, "subscribe", "resubscribed");
  assert.ok(w1.closed);
  assert.deepEqual(states, ["connecting", "open", "closed", "connecting", "open"]);
  sup.stop(); assert.equal(ck.pending(), 0, "no timers left after stop");
});

test("supervisor: backoff grows exponentially with jitter and is capped", () => {
  assert.equal(backoffMs(0, { random: () => 1 }), 1000);
  assert.equal(backoffMs(3, { random: () => 1 }), 8000);
  assert.equal(backoffMs(10, { random: () => 1 }), 30000);
  assert.equal(backoffMs(3, { random: () => 0.5 }), 4000);
  const { ck, sup } = makeSup(); sup.start();
  for (let i = 0; i < 4; i++) FakeWS.instances[i].drop(), ck.advance(Math.min(30000, 1000 * 2 ** i));
  assert.equal(FakeWS.instances.length, 5);
  sup.stop();
});

test("supervisor: a silent connection (no frames at all) is torn down and replaced", () => {
  const { ck, sup } = makeSup({ silenceMs: 60000, pingMs: 25000 });
  sup.start(); FakeWS.instances[0].open();
  ck.advance(75000);                                 // ping at 25, 50 (ok), 75 -> silence 75 s > 60 s
  assert.ok(FakeWS.instances[0].closed);
  ck.advance(1000); assert.equal(FakeWS.instances.length, 2);
  sup.stop();
});

// ---------------------------------------------------------------- REST
test("rest: retries 429 with backoff, fails fast on API error codes, spaces requests", async () => {
  const sleeps = []; let t = 0, calls = 0;
  const responses = [{ status: 429 }, { status: 200, body: { code: "00000", data: { serverTime: "1000" } } }];
  const r = new BitgetRest({ fetchImpl: async () => { calls++; const x = responses.shift(); return { status: x.status, json: async () => x.body }; },
    sleep: async ms => { sleeps.push(ms); t += ms; }, now: () => t, random: () => 1, minIntervalMs: 100 });
  const out = await r.get("/api/v2/public/time");
  assert.equal(out.body.code, "00000"); assert.equal(calls, 2); assert.ok(sleeps.includes(1000), "backoff before retry");
  const r2 = new BitgetRest({ fetchImpl: async () => ({ status: 200, json: async () => ({ code: "40034", msg: "param error" }) }), sleep: async () => {} });
  await assert.rejects(r2.get("/x"), /code=40034/);
});

// ---------------------------------------------------------------- collector (end to end with fakes)
function fakeRest({ contractsFail = false } = {}) {
  let n = 0;
  return { stats: {}, calls: [],
    async contracts() { if (contractsFail) throw new Error("network down"); return { body: CONTRACTS, recvTs: 1 }; },
    async clockOffset() { return { offset_ms: 12, rtt_ms: 80 }; },
    async candles(sym, pt, gran) {   // the fixture is 1m; for other intervals return only rows aligned to that interval
      this.calls.push(gran); n++; const b = clone(REST_CANDLES);
      b.data = b.data.filter(r => Number(r[0]) % S.INTERVAL_MS[gran] === 0);
      return { body: b, recvTs: b.requestTime + 50 };
    } };
}

async function startCollector(store, rest, ck) {
  FakeWS.reset();
  const health = new Health({ now: ck.now });
  const col = new BitgetCollector({ rest, store, health, symbols: ["BTCUSDT"], now: ck.now, WebSocketImpl: FakeWS, wsUrl: "wss://x",
    supervisorOpts: { setTimer: ck.setTimer, clearTimer: ck.clearTimer, random: () => 1 } });
  await col.start();
  return { col, health };
}

test("collector: real messages flow to storage; replayed trades after reconnect are deduplicated; bad input is quarantined", async () => {
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const rest = fakeRest();
  const { col, health } = await startCollector(store, rest, ck);
  assert.deepEqual(rest.calls, ["1m", "5m", "15m", "4H"], "startup backfill");
  const w = FakeWS.instances[0]; w.open();
  for (const m of CAP) w.msg(m);
  store.flush();
  const nTrades = store.count("trades");
  assert.ok(nTrades > 0); assert.ok(store.count("tickers") >= 1); assert.ok(store.count("book_tops") >= 1);
  assert.equal(col.books[BTC].state, "VALID");
  assert.equal(health.snapshot().feeds.find(f => f.feed === BTC + "|trade").state, "HEALTHY");

  w.drop(); assert.equal(col.books[BTC].state, "EMPTY", "book reset on disconnect");
  ck.advance(1000); const w2 = FakeWS.instances[1]; w2.open();
  await new Promise(r => setImmediate(r));
  for (const m of of("trade")) w2.msg(m);            // exchange replays a snapshot of recent trades
  store.flush();
  assert.equal(store.count("trades"), nTrades, "no duplicate trades after reconnect");
  const evs = store.feedEvents(50).map(e => e.event);
  assert.ok(evs.includes("possible_trade_gap")); assert.ok(evs.includes("rest_backfill"));

  w2.msg("{not json"); w2.msg({ action: "update", arg: { instType: "USDT-FUTURES", channel: "trade", instId: "DOGEUSDT" }, data: [] });
  const bad = clone(of("trade", "snapshot")[0]); bad.data[0].price = "NaN"; w2.msg(bad);
  assert.equal(store.count("quarantine"), 3);
  col.stop(); store.close();
});

test("collector: a book sequence gap marks the book invalid and resubscribes exactly once", async () => {
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const { col } = await startCollector(store, fakeRest(), ck);
  const w = FakeWS.instances[0]; w.open();
  const books = of("books");
  w.msg(books[0]); w.msg(books[1]); w.msg(books[3]); w.msg(books[4]);   // gap after books[1]
  assert.equal(col.books[BTC].state, "INVALID");
  const ops = w.subs().map(s => s.op);
  assert.equal(ops.filter(o => o === "unsubscribe").length, 1); assert.equal(ops.filter(o => o === "subscribe").length, 2);
  assert.equal(store.feedEvents(10).find(e => e.event === "book_invalid").feed, BTC + "|books");
  w.msg(books[0]); assert.equal(col.books[BTC].state, "VALID", "fresh snapshot restores it");
  col.stop(); store.close();
});

test("collector: restart with the contracts endpoint down uses cached metadata and says so", async () => {
  const dir = tmpdir(), f = path.join(dir, "m.db"), ck = makeClock(of("trade", "snapshot")[0].ts);
  let store = new Store(f, { now: ck.now });
  let c = await startCollector(store, fakeRest(), ck); c.col.stop(); store.close();
  store = new Store(f, { now: ck.now });
  c = await startCollector(store, fakeRest({ contractsFail: true }), ck);
  assert.equal(c.col.idOf.BTCUSDT, BTC);
  assert.ok(store.feedEvents(20).some(e => e.event === "using_cached_metadata"));
  c.col.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  const s2 = new Store(":memory:");
  await assert.rejects(startCollector(s2, fakeRest({ contractsFail: true }), ck), /no instrument metadata/);
  s2.close();
});

// ---------------------------------------------------------------- HTTP API
test("http: health/API work on localhost only; methods, hosts, paths and params are validated; no secrets leak", async () => {
  process.env.ALEXISMETA_TEST_SECRET = "sk-test-DO-NOT-LEAK-123";
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const { col, health } = await startCollector(store, fakeRest(), ck);
  FakeWS.instances[0].open(); for (const m of CAP) FakeWS.instances[0].msg(m); store.flush();
  const ledger = new (require("../server/ledger").Ledger)(store, { now: ck.now });
  ledger.append({ entry_id: "t:1", kind: "decision", versions: { v: 1 }, payload: { intent: "NO_TRADE" } });
  const api = buildApi({ store, health, collector: col, startedAt: 0, ledger });
  const server = createServer({ api, staticDir: path.join(__dirname, "..", "docs") });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const req = (p, { method = "GET", host = `127.0.0.1:${port}` } = {}) => new Promise((res, rej) => {
    const r = require("node:http").request({ host: "127.0.0.1", port, path: p, method, headers: { host } }, x => {
      let s = ""; x.on("data", d => s += d); x.on("end", () => res({ code: x.statusCode, body: s, headers: x.headers }));
    }); r.on("error", rej); r.end();
  });
  try {
    const h = await req("/api/health");
    assert.equal(h.code, 200);
    const hj = JSON.parse(h.body);
    assert.equal(hj.data_mode, "LIVE"); assert.equal(hj.execution_mode, "ANALYSIS_ONLY"); assert.match(hj.live_trading, /UNAVAILABLE/);
    assert.equal(h.headers["access-control-allow-origin"], undefined);
    assert.equal((await req("/api/health", { method: "POST" })).code, 405);
    assert.equal((await req("/api/health", { host: "evil.example:80" })).code, 421);
    assert.equal((await req("/api/candles?instrument=nope")).code, 400);
    assert.equal((await req("/api/candles?instrument=bitget:perp:DOGEUSDT")).code, 404);
    assert.equal((await req(`/api/candles?instrument=${BTC}&interval=1m&limit=99999`)).code, 400);
    assert.equal((await req(`/api/candles?instrument=${BTC}&interval=7m`)).code, 400);
    const cd = JSON.parse((await req(`/api/candles?instrument=${BTC}&interval=1m&limit=3`)).body);
    assert.equal(cd.candles.length, 3);
    const tk = JSON.parse((await req(`/api/ticker?instrument=${BTC}`)).body);
    assert.ok(tk.ticker.spread_bps >= 0);
    assert.notEqual((await req("/../server/main.js")).code, 200);
    assert.notEqual((await req("/%2e%2e/server/main.js")).code, 200);
    const lv = JSON.parse((await req("/api/ledger/verify")).body);
    assert.equal(lv.ok, true); assert.equal(lv.entries, 1);
    assert.equal(JSON.parse((await req("/api/ledger?limit=5")).body).entries.length, 1);
    const idx = await req("/");
    assert.equal(idx.code, 200); assert.match(idx.body, /<html/i);
    for (const p of ["/api/health", "/api/instruments", `/api/trades?instrument=${BTC}`, `/api/book?instrument=${BTC}`, "/api/feed-events"]) {
      const b = (await req(p)).body;
      assert.ok(!b.includes("sk-test-DO-NOT-LEAK"), "secret leaked in " + p);
      assert.ok(!/stack|\/home\/|\\Users\\/.test(b), "internal detail leaked in " + p);
    }
  } finally { server.close(); col.stop(); store.close(); delete process.env.ALEXISMETA_TEST_SECRET; }
});

// ---------------------------------------------------------------- finality & coverage (added after the steady-run finding)
test("collector: a bar the stream never finalised is finalised from REST after the next bar opens", async () => {
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const t0 = 60000 * Math.floor(ck.now() / 60000);
  // REST stub returns the closed bar t0 as final (requestTime after its end) plus the forming bar
  const rest = fakeRest(); const restCandles = rest.candles.bind(rest); let armed = false;
  rest.candles = async (sym, pt, gran, opts) => {
    if (gran !== "1m" || !armed) return restCandles(sym, pt, gran, opts);
    rest.calls.push("1m-finalize");
    return { body: { code: "00000", requestTime: t0 + 61000, data: [[String(t0), "100", "105", "99", "104", "9.5", "950"], [String(t0 + 60000), "104", "104", "104", "104", "0.1", "10"]] }, recvTs: t0 + 61050 };
  };
  const { col } = await startCollector(store, rest, ck);
  col.setTimer = ck.setTimer; col.clearTimer = ck.clearTimer; armed = true;
  const w = FakeWS.instances[0]; w.open();
  const push = (open, c, ts) => w.msg({ action: "update", arg: { instType: "USDT-FUTURES", channel: "candle1m", instId: "BTCUSDT" }, ts, data: [[String(open), "100", "105", "99", c, "9", "900"]] });
  ck.advance(5000); push(t0, "103", ck.now());                 // last push for bar t0 arrives BEFORE its close
  store.flush();
  let row = store.candles(BTC, "1m", 200).find(r => r.open_ts === t0);
  assert.equal(row.final, 0); assert.equal(row.c, "103");
  ck.advance(t0 + 61000 - ck.now()); push(t0 + 60000, "104", ck.now());  // next bar opens -> finaliser scheduled
  ck.advance(3000); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  row = store.candles(BTC, "1m", 200).find(r => r.open_ts === t0);
  assert.equal(row.final, 1, "finalised"); assert.equal(row.c, "104", "REST close replaces the stale last push"); assert.equal(row.source, "bitget_rest_v2");
  assert.ok(rest.calls.includes("1m-finalize"));
  col.stop(); store.close();
});

test("coverage: disconnects, invalid books and downtime become gaps; coverage() reports them", async () => {
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const { col } = await startCollector(store, fakeRest(), ck);
  const w = FakeWS.instances[0]; w.open();
  for (const m of CAP) w.msg(m); store.flush();
  const t1 = ck.now();
  ck.advance(2000); w.drop();                                   // last frame at t1 -> gap starts at t1, not at the drop
  ck.advance(1000); const w2 = FakeWS.instances[1]; w2.open();
  const g = store.coverage(BTC, "ticker", t1 - 1, ck.now() + 1);
  assert.equal(g.complete, false); assert.ok(g.reasons.includes("gap_in_window"));
  assert.equal(g.gaps[0].from_ts, t1); assert.equal(g.gaps[0].reason, "ws_disconnect");
  const books = of("books");                                    // book invalid -> gap until a fresh snapshot
  w2.msg(books[0]); w2.msg(books[2]); ck.advance(500); w2.msg(books[0]);
  assert.ok(store.coverage(BTC, "book", 0, ck.now() + 1).gaps.some(x => x.reason === "book_invalid"));
  const before = store.coverage(BTC, "trade", 0, t1);
  assert.ok(before.reasons.includes("observation_started_after_window_start"), "nothing observed before the first message");
  col.stop(); store.close();
});

test("coverage: a crash (no shutdown record) is detected on restart and the downtime is a gap from the last message of any kind", async () => {
  const dir = tmpdir(), f = path.join(dir, "m.db"), ck = makeClock(of("trade", "snapshot")[0].ts);
  let store = new Store(f, { now: ck.now });
  store.feedEvent("worker", "start", "x");
  let c = await startCollector(store, fakeRest(), ck);
  FakeWS.instances[0].open(); for (const m of CAP) FakeWS.instances[0].msg(m); store.flush();
  const lastTicker = store.lastRecvTs(BTC, "ticker");
  store.db.close();                                             // simulated power loss: no shutdown event, no stop()
  ck.advance(60000);
  store = new Store(f, { now: ck.now });
  const prev = store.lastWorkerEvent();
  assert.equal(prev.event, "start", "previous run never recorded a shutdown");
  c = await startCollector(store, fakeRest(), ck);
  c.col.recordDowntime(true, null);
  const gaps = store.coverage(BTC, "trade", 0, ck.now() + 1).gaps.filter(x => x.reason === "downtime_after_unclean_stop");
  assert.ok(gaps.length >= 1);
  assert.equal(gaps[0].from_ts, Math.max(lastTicker, store.lastRecvTs(BTC, "trade"), store.lastRecvTs(BTC, "book")), "from the last message of any kind");
  c.col.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("collector: a channel that stalls while the socket stays open is recorded as unobserved and triggers a reconnect", async () => {
  const ck = makeClock(of("trade", "snapshot")[0].ts), store = new Store(":memory:", { now: ck.now });
  const { col } = await startCollector(store, fakeRest(), ck);
  const w = FakeWS.instances[0]; w.open(); for (const m of CAP) w.msg(m);
  const lastTick = col.health.feeds.get(BTC + "|ticker").last_recv_ts;
  for (let i = 0; i < 15; i++) { ck.advance(1000); w.msg("pong"); }       // pongs only: the supervisor's own watchdog stays quiet
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(col.checkStalls(), 1);
  const g = store.coverage(BTC, "ticker", lastTick - 1, ck.now() + 1).gaps;
  assert.ok(g.some(x => x.reason === "stalled_channel" && x.from_ts === lastTick));
  assert.equal(FakeWS.instances.length, 2, "forced reconnect"); assert.ok(w.closed);
  FakeWS.instances[1].open(); assert.equal(col.checkStalls(), 0, "RECOVERING after reconnect is not a stall");
  col.stop(); store.close();
});
