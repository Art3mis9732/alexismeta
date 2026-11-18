"use strict";
/* Live paper monitor: backend views, stream and runtime identity. Deterministic; no network beyond loopback. */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { Store } = require("../server/store");
const { Ledger } = require("../server/ledger");
const { PaperEngine } = require("../server/engine");
const { Monitor } = require("../server/monitor");
const { Health } = require("../server/health");
const { createServer } = require("../server/http");
const { buildApi } = require("../server/main");
const { buildInfo, sourceFingerprint } = require("../server/runtime");
const { fromBitgetContract } = require("../server/instruments");
const CONTRACTS = require("./fixtures/bitget/contracts.json");

const ID = "bitget:perp:BTCUSDT", CLOSE = Date.UTC(2026, 10, 16, 9);
const snapOf = (o = {}) => ({ instrument_id: ID, bar_close_ts: CLOSE, decision_ts: CLOSE + 3000, hash: "h" + JSON.stringify(o).length, missing: [],
  health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY", candle15m: "HEALTHY" }, book_state: "VALID", coverage_complete: true, coverage_reasons: [],
  trend_1h: 1, above_vwap: true, atr: 120, atr_pct: 0.19, atr_pctile: 0.4, change_24h: 0.012, spread_bps: 0.02, bid: 64899.9, ask: 64900,
  depth_10bps: { bid: 200000, ask: 180000 }, funding_rate: 0.0001, data_cutoff_ts: CLOSE + 2000, triggers: [{ code: "RETEST_UP", name: "RETEST_UP", dir: 1, stop: 64600, level: null }], ...o });

function rig({ snap = snapOf(), environment = "FORWARD" } = {}) {
  let t = CLOSE + 3000; const now = () => t;
  const store = new Store(":memory:", { now }), ledger = new Ledger(store, { now, codeRev: "test" });
  store.upsertInstrument(fromBitgetContract(CONTRACTS.data.find(c => c.symbol === "BTCUSDT"), "USDT-FUTURES", t));
  const book = { state: "VALID", recvTs: t, top: () => ({ bids: [["65000", "0.004"], ["64990", "50"]], asks: [["65010", "50"]] }) };
  const collector = { idOf: { BTCUSDT: ID }, latestTicker: { [ID]: { last: "65005", bid: "65000", ask: "65010", mark: "65012.98", index_px: "65011", exch_ts: t, recv_ts: t, next_funding_ts: CLOSE + 4 * 3600000 } }, books: { [ID]: book } };
  const health = new Health({ now });
  let current = snap;
  const engine = new PaperEngine({ store, ledger, collector, health, now, buildSnapshot: () => current, environment });
  engine.feedHealthy = () => true;
  const runtime = { build: buildInfo(), instance_id: engine.instanceId, started_at: t, database: store.identity(environment), engine_error: null };
  const monitor = new Monitor({ store, collector, health, getEngine: () => engine, runtime, now, labDir: "/nonexistent-lab-dir" });
  return { store, ledger, engine, monitor, collector, health, runtime, now, at: v => { t = v; book.recvTs = v; collector.latestTicker[ID].recv_ts = v; }, setSnap: s => { current = s; } };
}
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m || ""} got ${a}, expected ${b}`);

test("monitor: every displayed position traces to its ledger decision and fills; valuation matches the hand formula", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const s = r.monitor.snapshot();
  assert.equal(s.schema_version, "monitor-v1"); assert.equal(s.mode, "PAPER"); assert.equal(s.environment, "FORWARD"); assert.equal(s.positions.length, 3);
  for (const p of s.positions) {
    const fills = r.store.db.prepare("SELECT * FROM paper_fills WHERE position_id=?").all(p.position_id);
    assert.equal(fills.length, 1); near(p.entry_fill_price, fills[0].price);                       // actual recorded simulated fill
    assert.ok(r.ledger.get(p.decision_id), "decision exists in the ledger"); assert.ok(r.ledger.get("open:" + p.decision_id));
    near(p.entry_fill_price, 64900 * 1.0002);                                                       // 64912.98
    near(p.valuation.u_mark, p.remaining_qty * (65012.98 - 64912.98), "U_mark = q x (mark - entry)"); // = q x 100
    assert.equal(p.valuation.mark.status, "OK"); assert.equal(p.quotes.last, 65005); assert.equal(p.quotes.mark, 65012.98);
    assert.notEqual(p.valuation.u_mark, p.valuation.close_now.remaining_close_contribution, "mark value and close-now estimate are different numbers");
    near(p.margin.reserved, p.remaining_entry_notional / 2);
    assert.ok(p.valuation.pct.gross_unrealized_pct_of_entry_notional > 0 && "gross_unrealized_pct_of_initial_margin" in p.valuation.pct);
    assert.ok(p.open_risk_usdt > 0 && p.distance_to_invalidation_pct > 0); assert.equal(p.data_state, "COMPLETE");
  }
  const small = s.positions.find(p => p.analyst === "defensive"), big = s.positions.find(p => p.analyst === "risk_taker");
  assert.equal(small.valuation.close_now.status, "OK"); near(small.valuation.close_now.x, 65000, "a small position closes entirely at the best bid");
  assert.ok(big.remaining_qty > 0.004, "larger than the best bid size");
  near(big.valuation.close_now.x, (0.004 * 65000 + (big.remaining_qty - 0.004) * 64990) / big.remaining_qty, "a larger position walks into the second level");
});

test("monitor: accounts are independent (never summed), reconcile with fills, and keep uncertain trades visible", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  const a = r.monitor.accounts();
  assert.equal(a.accounts.length, 3); assert.match(a.structure, /3 independent paper portfolios of 1000 USDT each \(total starting capital 3000 USDT\)/);
  for (const x of a.accounts) {
    assert.equal(x.starting_capital, 1000); assert.equal(x.cash_reconciles, true);
    near(x.mark_equity, x.cash_balance + x.unrealized_mark); near(x.available_balance, x.cash_balance - x.reserved_margin);
    assert.ok(x.cash_balance < 1000, "entry fee already paid"); assert.equal(x.valuation_status, "OK"); assert.equal(x.edge_status, "NO_DEMONSTRATED_EDGE");
  }
  r.store.addGap(ID, "trade", CLOSE + 4000, CLOSE + 5000, "ws_disconnect"); r.at(CLOSE + 6000); r.engine.manage();
  const b = r.monitor.accounts().accounts[0];
  assert.equal(b.counts.open_gap_affected, 1); assert.ok(b.unresolved_exposure_usdt > 0);
  assert.equal(r.monitor.positions()[0].data_state, "GAP_AFFECTED"); assert.equal(r.monitor.positions()[0].path_resolved, false);
  r.at(CLOSE + 60000);                                                       // quotes not refreshed for a minute -> valuation is STALE, not silently fresh
  r.collector.latestTicker[ID].recv_ts = CLOSE + 6000; r.collector.books[ID].recvTs = CLOSE + 6000;
  const st = r.monitor.positions()[0].valuation;
  assert.equal(st.mark.status, "STALE"); assert.equal(st.u_mark_is_stale, true); assert.equal(r.monitor.accounts().accounts[0].valuation_status, "STALE");
});

test("monitor: with no positions it reports none and explains the last decisions predicate by predicate", () => {
  const r = rig({ snap: snapOf({ triggers: [] }) }); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(r.monitor.positions(), []);
  const d = r.monitor.diagnostics(), row = d.rows.find(x => x.analyst === "balanced");
  assert.equal(row.last_decision.code, "NO_TRIGGER"); assert.match(row.predicates.blocking, /accepted trigger/);
  assert.ok(row.predicates.predicates.filter(p => p.pass === true).length >= 5, "passed predicates are listed too");
  assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM paper_positions").get().n, 0, "nothing fabricated");
  const reg = r.monitor.registry();
  assert.ok(reg.strategies.every(s => s.type === "DETERMINISTIC" && s.training === "NOT_APPLICABLE" && s.edge === "NOT_DEMONSTRATED")); assert.deepEqual(reg.models, []);
  assert.equal(r.monitor.jobs().training_backend, "UNAVAILABLE"); assert.deepEqual(r.monitor.jobs().jobs, []);
});

test("monitor: position detail carries decision, evidence, risk history, fills, funding, gaps and a gap-marked chart", () => {
  const r = rig(); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  for (const m of [0, 1, 4, 5]) r.store.enqueue({ type: "candle", instrument_id: ID, interval: "1m", open_ts: CLOSE + m * 60000, o: "64900", h: "64950", l: "64890", c: "64940", base_vol: "1", quote_vol: null,
    final: 1, exch_ts: CLOSE + (m + 1) * 60000, recv_ts: CLOSE + (m + 1) * 60000, source: "test", schema_version: 1, quality: [] });
  r.store.flush(); r.at(CLOSE + 6 * 60000);
  const id = r.monitor.positions()[0].position_id, d = r.monitor.detail(id);
  assert.equal(d.decision.intent, "OPEN_LONG"); assert.ok(d.decision.setup.supporting.length >= 1); assert.ok(Array.isArray(d.decision.setup.contradicting));
  assert.equal(d.evidence.hash, d.decision.evidence_hash); assert.equal(d.predicates.all_pass, true);
  assert.deepEqual(d.ledger_history.map(x => x.kind + ":" + (x.payload.state || x.payload.intent)), ["decision:OPEN_LONG", "status:RISK_APPROVED", "status:POSITION_OPENED"]);
  assert.equal(d.fills.length, 1); assert.deepEqual(d.funding, []); assert.equal(d.stop_target_changes.permitted, false);
  assert.equal(d.chart.candles.length, 4); assert.deepEqual(d.chart.missing_ranges, [{ after: CLOSE + 60000, before: CLOSE + 4 * 60000 }], "the hole in the candles is reported, not drawn over");
  assert.equal(r.monitor.detail("pos:nope"), null);
});

// ---------------------------------------------------------------- HTTP + SSE
async function serve(r) {
  const api = buildApi({ store: r.store, health: r.health, collector: { ...r.collector, bookSummaries: () => [], sup: { stats: {} }, rest: { stats: {} } }, startedAt: 0, ledger: r.ledger, getEngine: () => r.engine, monitor: r.monitor, runtime: r.runtime });
  const server = createServer({ api, staticDir: path.join(__dirname, "..", "docs") });
  await new Promise(res => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const get = (p, headers = {}) => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, x => { let s = ""; x.on("data", d => s += d); x.on("end", () => res({ code: x.statusCode, body: s })); }).on("error", rej));
  /** Read SSE frames until `until(frames)` is true or the timeout passes. */
  const sse = (p, until, headers = {}) => new Promise((res, rej) => {
    const frames = []; let buf = "";
    const rq = http.get({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, x => {
      const done = () => { clearTimeout(timer); rq.destroy(); res(frames); };
      const timer = setTimeout(done, 4000);
      x.on("data", d => { buf += d; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const ev = (f.match(/^event: (.*)$/m) || [])[1], id = (f.match(/^id: (.*)$/m) || [])[1], data = (f.match(/^data: (.*)$/m) || [])[1];
          if (ev) frames.push({ event: ev, id: id === undefined ? null : Number(id), data: JSON.parse(data) }); }
        if (until(frames)) done(); });
    }); rq.on("error", rej);
  });
  return { port, get, sse, close: () => { r.monitor.stop(); server.close(); } };
}

test("stream: snapshot cursor + events after it; reconnect resumes without duplicates; unusable cursors force a resnapshot", async () => {
  const r = rig(), s = await serve(r);
  try {
    const snap0 = JSON.parse((await s.get("/api/paper/snapshot")).body), c0 = snap0.cursor;
    r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);                                   // 3 x (candidate, risk, fill) = 9 durable events
    const f1 = await s.sse(`/api/stream?after=${c0}`, fr => fr.filter(x => x.event === "activity").length >= 9 && fr.some(x => x.event === "valuation"));
    assert.equal(f1[0].event, "hello"); assert.equal(f1[0].data.instance_id, r.runtime.instance_id); assert.equal(f1[0].data.db_id, r.runtime.database.db_id);
    const act = f1.filter(x => x.event === "activity");
    assert.equal(act.length, 9); assert.deepEqual(act.map(x => x.data.type).slice(0, 3), ["SETUP_CANDIDATE", "RISK_APPROVED", "FILL"]);
    act.forEach((x, i) => { assert.equal(x.id, x.data.seq); assert.equal(x.data.prev, i === 0 ? c0 : act[i - 1].data.seq, "prev links let the client detect a gap"); });
    const val = f1.find(x => x.event === "valuation");
    assert.equal(val.id, null, "valuation frames are not durable"); assert.equal(val.data.positions.length, 3); assert.equal(val.data.engine.state, "NOT_STARTED" === val.data.engine.state ? "x" : val.data.engine.state);
    const last = act[act.length - 1].id;
    const f2 = await s.sse("/api/stream", fr => fr.some(x => x.event === "valuation"), { "Last-Event-ID": String(last) });   // browser-style resume
    assert.equal(f2.filter(x => x.event === "activity").length, 0, "nothing is replayed after the last seen event");
    const f3 = await s.sse(`/api/stream?after=${last - 2}`, fr => fr.filter(x => x.event === "activity").length >= 2);
    assert.deepEqual(f3.filter(x => x.event === "activity").map(x => x.id), [last - 1, last], "exactly the missed events, in order");
    const f4 = await s.sse("/api/stream?after=999999", fr => fr.some(x => x.event === "resnapshot"));
    assert.ok(f4.some(x => x.event === "resnapshot"), "a cursor from another database cannot be resumed");
    assert.equal((await s.get("/api/stream?after=abc")).code, 400);
    const again = JSON.parse((await s.get("/api/paper/snapshot")).body);
    assert.equal(again.positions.length, 3); assert.equal(r.store.db.prepare("SELECT COUNT(*) n FROM paper_positions").get().n, 3, "reading snapshots and streams never creates trades");
  } finally { s.close(); r.store.close(); }
});

test("runtime identity: build fingerprint matches the working tree, the database identity is opaque, nothing private leaks; cross-origin is refused", async () => {
  const r = rig(), s = await serve(r);
  try {
    const rt = JSON.parse((await s.get("/api/runtime")).body);
    assert.equal(rt.build.source_fingerprint, sourceFingerprint(), "the process under test serves exactly this working tree");
    assert.match(rt.instance_id, /^[0-9a-f-]{36}$/); assert.match(rt.database.db_id, /^[0-9a-f-]{36}$/); assert.equal(rt.database.environment, "FORWARD");
    assert.equal(rt.api_schema_version, "api-v2"); assert.deepEqual(Object.values(rt.strategy_versions), ["risk_taker-v1", "balanced-v1", "defensive-v1"]);
    assert.match(rt.execution, /PAPER/); assert.equal(rt.engine.state, "STALLED", "an engine that has never ticked is not reported as running");
    for (const p of ["/api/runtime", "/api/paper/snapshot", "/api/paper/diagnostics", "/api/registry", "/api/jobs"]) {
      const b = (await s.get(p)).body; assert.ok(!/\/home\/|\/tmp\/|\\Users\\|\.db"|market\.db/.test(b), "path leaked in " + p);
    }
    assert.equal((await s.get("/api/paper/snapshot", { origin: "https://evil.example" })).code, 403);
    assert.equal((await s.get("/api/paper/snapshot", { origin: `http://127.0.0.1:${s.port}` })).code, 200);
    assert.equal((await s.get("/api/paper/position?id=../../etc")).code, 400); assert.equal((await s.get("/api/paper/position?id=pos:none")).code, 404);
    assert.equal((await s.get("/api/paper/activity?type=drop%20table")).code, 400);
    r.engine.tick(); assert.equal(JSON.parse((await s.get("/api/runtime")).body).engine.state, "RUNNING");
  } finally { s.close(); r.store.close(); }
});

test("environments: a TEST database is labelled TEST everywhere and can never be opened as the forward ledger", () => {
  const r = rig({ environment: "TEST" }); r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.equal(r.monitor.snapshot().environment, "TEST");
  assert.equal(JSON.parse(r.store.db.prepare("SELECT payload FROM ledger_entries WHERE kind='decision' LIMIT 1").get().payload).environment, "TEST");
  assert.throws(() => new PaperEngine({ store: r.store, ledger: r.ledger, collector: r.collector, health: r.health, now: () => r.now() + 60000, environment: "FORWARD" }), /environment is TEST/);
  assert.throws(() => require("../server/fixture").start({ engine: {}, collector: {}, store: {}, health: {}, log() {}, identity: { environment: "FORWARD" }, timers: [] }), /not TEST/);
  assert.throws(() => require("../server/main").args(["n", "m", "--fixture"]), /only allowed with --env test/);
});

test("news API: validated filters, source health, counts and no private paths; relevant-only by default", async () => {
  const { NewsIngester, SOURCES } = require("../server/news");
  const r = rig(), news = new NewsIngester({ store: r.store, now: r.now, sources: SOURCES });
  const fs = require("node:fs");
  news.ingest(SOURCES.find(s => s.id === "sec_press"), fs.readFileSync(path.join(__dirname, "fixtures", "news", "sec_press.xml"), "utf8"));
  const api = buildApi({ store: r.store, health: r.health, collector: { ...r.collector, bookSummaries: () => [], sup: { stats: {} }, rest: { stats: {} } }, startedAt: 0, ledger: r.ledger, getEngine: () => r.engine, monitor: r.monitor, runtime: r.runtime, news });
  const server = createServer({ api, staticDir: path.join(__dirname, "..", "docs") });
  await new Promise(res => server.listen(0, "127.0.0.1", res)); const port = server.address().port;
  const get = p => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, x => { let s = ""; x.on("data", d => s += d); x.on("end", () => res({ code: x.statusCode, body: s })); }).on("error", rej));
  try {
    const a = JSON.parse((await get("/api/news")).body);
    assert.equal(a.schema_version, "news-v2"); assert.equal(a.counts.total, 25); assert.ok(a.counts.relevant >= 1 && a.counts.hidden_not_relevant === 25 - a.counts.relevant);
    assert.ok(a.items.length === a.counts.relevant && a.items.every(i => ["ASSET", "MACRO", "EXCHANGE_OPS"].includes(i.scope)));
    assert.equal(a.sources.length, 7); assert.ok(a.sources.find(s => s.source === "sec_press").newest_item_published_ts); assert.equal(a.interpreters["llm-grounded"].enabled, false);
    const all = JSON.parse((await get("/api/news?all=1&limit=200")).body); assert.equal(all.items.length, 25);
    assert.equal((await get("/api/news?asset=DOGE")).code, 400); assert.equal((await get("/api/news?scope=x%27")).code, 400); assert.equal((await get("/api/news?source=a/b")).code, 400); assert.equal((await get("/api/news?all=yes")).code, 400);
    assert.ok(!/\/home\/|\/tmp\/|\.db"/.test((await get("/api/news?all=1")).body));
    const item = a.items[0]; assert.ok(Array.isArray(item.reaction) && item.reaction.every(x => x.horizons.every(h => h.status !== "OK")), "no candles stored -> reactions are N/A or pending, never invented");
  } finally { server.close(); r.monitor.stop(); r.store.close(); }
});

test("news shadow: the engine's decisions, ledger and positions are identical with a recording shadow, with a throwing shadow, and without one; candidates are recorded", () => {
  const { NewsShadow } = require("../server/news_shadow"), plain = rig(), rec = rig(), bad = rig();
  const news = { itemsAsOf: () => [] };
  rec.engine.newsShadow = new NewsShadow({ db: rec.store.db, news, now: rec.now });
  bad.engine.newsShadow = { record() { throw new Error("shadow exploded"); } };
  const strip = r => ({ ledger: r.store.db.prepare("SELECT entry_id, kind, payload FROM ledger_entries ORDER BY seq").all().map(x => [x.entry_id, x.kind, x.payload]),
    pos: r.store.db.prepare("SELECT position_id, qty, entry, stop, target FROM paper_positions ORDER BY position_id").all() });
  for (const r of [plain, rec, bad]) r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(strip(rec), strip(plain)); assert.deepEqual(strip(bad), strip(plain)); assert.ok(strip(plain).pos.length >= 1);
  const rows = rec.store.db.prepare("SELECT analyst, verdict, intent, risk_outcome FROM news_shadow").all();
  assert.equal(rows.length, 3); assert.ok(rows.every(x => x.verdict === "NO_RELEVANT_NEWS" && x.intent === "OPEN_LONG" && x.risk_outcome === "OPENED"));
  assert.equal(plain.store.db.prepare("SELECT COUNT(*) n FROM news_shadow").get().n, 0);
});

test("filter shadow: engine decisions, ledger and positions are identical with a recording, a throwing and no filter shadow; entry candidates are recorded", () => {
  const { FilterShadow } = require("../server/filter_shadow"), risk = require("../server/risk"), plain = rig(), rec = rig(), bad = rig();
  rec.engine.filterShadow = new FilterShadow({ db: rec.store.db, ledger: rec.ledger, config: risk.RISK_DEFAULTS, environment: "FORWARD", now: rec.now }); bad.engine.filterShadow = { record() { throw new Error("boom"); } };
  const strip = r => ({ l: r.store.db.prepare("SELECT entry_id, kind, payload FROM ledger_entries ORDER BY seq").all().map(x => [x.entry_id, x.kind, x.payload]), p: r.store.db.prepare("SELECT position_id, qty, entry, stop FROM paper_positions ORDER BY position_id").all() });
  for (const r of [plain, rec, bad]) r.engine.onBarClose(ID, CLOSE, CLOSE + 3000);
  assert.deepEqual(strip(rec), strip(plain)); assert.deepEqual(strip(bad), strip(plain));
  const rows = rec.store.db.prepare("SELECT analyst, intent, risk_outcome, stop_bps FROM filter_shadow").all(); assert.equal(rows.length, 3); assert.ok(rows.every(x => x.intent === "OPEN_LONG" && x.risk_outcome === "OPENED" && x.stop_bps > 0));
});
