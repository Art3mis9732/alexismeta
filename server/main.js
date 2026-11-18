"use strict";
/* alexismeta local worker: Bitget public collector + SQLite + local API/site on http://127.0.0.1:8787
 *
 *   node server/main.js                       run until Ctrl+C
 *   node server/main.js --smoke 30            run 30 s against the real exchange, verify storage + API, exit 0/1
 *   options: --port 8787 --db data/worker/market.db --symbols BTCUSDT,ETHUSDT,XRPUSDT
 *
 * Data mode is always LIVE here (real public data). Execution mode is ANALYSIS_ONLY: no order code exists. */

const path = require("node:path");
const { Store } = require("./store");
const { Health } = require("./health");
const { BitgetRest } = require("./adapters/bitget");
const { BitgetCollector } = require("./collector");
const { createServer } = require("./http");
const { Ledger } = require("./ledger");
const { PaperEngine } = require("./engine");
const { NewsIngester, SOURCES: NEWS_SOURCES, PARSER_VERSION } = require("./news");
const { withReaction } = require("./news_reaction"), { NewsShadow } = require("./news_shadow"), { FilterShadow } = require("./filter_shadow");
const { appliesTo, INTERPRETERS } = require("./news_interpret");
const { Monitor, MONITOR_SCHEMA } = require("./monitor");
const { StressMonitor } = require("./stress_monitor");
const { ValuationRecorder } = require("./valuation_recorder");
const stressFixture = require("./stress_fixture");
const Stress = require("./stress");
const { API_SCHEMA_VERSION, buildInfo } = require("./runtime");
const { ENGINE_VERSION } = require("./engine");
const { RULES } = require("./policies");
const { EVIDENCE_VERSION } = require("./evidence");
const { VALUATION_VERSION } = require("./accounting");

const ROOT = path.resolve(__dirname, "..");
const VERSION = "worker-0.2.0";

function args(argv) {
  const a = { port: 8787, db: null, symbols: ["BTCUSDT", "ETHUSDT", "XRPUSDT"], smoke: null, env: "FORWARD", fixture: false, stress: true, stressMode: "SHADOW", stressFixture: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--port") { a.port = Number(v); i++; }
    else if (k === "--db") { a.db = path.resolve(v); i++; }
    else if (k === "--symbols") { a.symbols = v.split(",").map(s => s.trim().toUpperCase()).filter(Boolean); i++; }
    else if (k === "--smoke") { a.smoke = Number(v) || 30; i++; }
    else if (k === "--env") { a.env = String(v).toUpperCase(); i++; }
    else if (k === "--fixture") a.fixture = true;
    else if (k === "--no-stress") a.stress = false;
    else if (k === "--stress-mode") { a.stressMode = String(v).toUpperCase(); i++; }
    else if (k === "--stress-fixture") a.stressFixture = true;
    else throw new Error("unknown option " + k);
  }
  if (!a.symbols.every(s => /^[A-Z0-9]{2,20}$/.test(s))) throw new Error("bad --symbols");
  if (a.env !== "FORWARD" && a.env !== "TEST") throw new Error("--env must be forward or test");
  if (!["SHADOW", "ENFORCE"].includes(a.stressMode)) throw new Error("--stress-mode must be shadow or enforce");
  if (a.stressFixture && a.env !== "TEST") throw new Error("--stress-fixture is only allowed with --env test (synthetic stress never touches the forward database)");
  if (a.fixture && a.env !== "TEST") throw new Error("--fixture is only allowed with --env test (fixtures never touch the forward ledger)");
  if (!a.db) a.db = path.join(ROOT, "data", "worker", a.env === "TEST" ? "test-fixture.db" : "market.db");   // separate database per environment
  return a;
}

function buildApi({ store, health, collector, startedAt, ledger, getEngine = () => null, news = null, monitor = null, runtime = null, getStress = () => null }) {
  const num = v => v === null || v === undefined ? null : Number(v);
  let counts = null, countsAt = 0;                      // COUNT(*) over millions of rows is slow: refresh at most once a minute
  const rowCounts = () => { if (!counts || Date.now() - countsAt > 60000) { countsAt = Date.now();
    counts = { trades: store.count("trades"), candles: store.count("candles"), tickers: store.count("tickers"), book_tops: store.count("book_tops"), quarantine: store.count("quarantine"), as_of: countsAt }; }
    return counts; };
  return {
    hasInstrument: id => !!store.instrument(id),
    health: () => ({
      version: VERSION, now: Date.now(), started_at: startedAt,
      data_mode: "LIVE", execution_mode: "ANALYSIS_ONLY", live_trading: "UNAVAILABLE (no order-placement code exists)",
      daily_accounting_boundary: "UTC 00:00",
      ...health.snapshot(),
      books: collector.bookSummaries(),
      news_sources: news ? news.status() : [],
      store: { db_bytes: store.sizeBytes(), queue: store.queue.length, ...store.stats,
        rows: rowCounts() },
      upstream: { ws: collector.sup.stats, rest: collector.rest.stats }
    }),
    instruments: () => store.instruments().map(i => { const { raw_json, ...rest } = i; return rest; }),
    feedEvents: n => store.feedEvents(n),
    candles: (id, iv, n, before) => ({ instrument_id: id, interval: iv, note: "final=0 marks the forming (partial) candle; prices are exact exchange decimal strings",
      candles: store.candles(id, iv, n, before).map(c => ({ ...c, quality: JSON.parse(c.quality) })) }),
    ticker: id => {
      const live = collector.latestTicker[id], t = live || store.latestTicker(id);
      if (!t) return { instrument_id: id, ticker: null };
      const feed = health.snapshot().feeds.find(f => f.feed === id + "|ticker");
      return { instrument_id: id, state: feed ? feed.state : "UNKNOWN", ticker: { ...t, quality: Array.isArray(t.quality) ? t.quality : JSON.parse(t.quality),
        spread_bps: t.bid && t.ask ? (num(t.ask) - num(t.bid)) / ((num(t.ask) + num(t.bid)) / 2) * 1e4 : null } };
    },
    trades: (id, n) => ({ instrument_id: id, note: "venue_side is Bitget's raw `side`; whether it denotes the taker is UNVERIFIED (D-008)",
      trades: store.trades(id, n).map(t => ({ ...t, quality: JSON.parse(t.quality) })) }),
    book: (id, n) => collector.bookTop(id, n),
    ledgerRecent: n => ledger ? { note: "append-only; originals are never modified, outcomes are separate rows", entries: ledger.recent(n) } : { entries: [] },
    ledgerVerify: () => ledger ? ledger.verify() : { ok: false, reason: "ledger not configured" },
    monitor,
    runtime: () => runtime ? { app: "alexismeta-worker", worker_version: VERSION, build: runtime.build, instance_id: runtime.instance_id, started_at: runtime.started_at,
      uptime_ms: Date.now() - runtime.started_at, api_schema_version: API_SCHEMA_VERSION, monitor_schema: MONITOR_SCHEMA, database: runtime.database,
      strategy_versions: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.version])), evidence_version: EVIDENCE_VERSION, valuation_version: VALUATION_VERSION,
      engine_version: ENGINE_VERSION, engine: monitor ? monitor.engineState() : null, collector: monitor ? monitor.feedSummary() : null,
      news: news ? news.status().map(s => ({ source: s.source, ok: !!s.last_ok_ts && !s.last_error, last_ok_ts: s.last_ok_ts })) : [],
      stream: monitor ? { clients: monitor.clients.size, ...monitor.streamStats } : null, fixture: runtime.fixture || null,
      stress: getStress() ? (() => { const x = getStress(); return { version: x.cfg.version, policy: Stress.POLICY_VERSION, mode: x.mode, mode_effective_ts: x.effective_ts, calibration: x.cfg.calibration.status, origin: x.origin, monitor_age_ms: x.last_tick_ts === null ? null : Date.now() - x.last_tick_ts }; })() : null,
      execution: "PAPER / SIMULATED. No order-placement code exists in this application." } : null,
    stress: (o = {}) => {
      const x = getStress(); if (!x) return { schema: "stress-api-v1", unavailable: "the stress monitor is not running in this instance", instruments: [], events: [] };
      const now = Date.now(), snap = x.snapshot(now);
      for (const i of snap.instruments) {                                                                   // relevant news is CONTEXT for the asset, never a cause: relevance is applied before the limit; time = the publication time when the source states one, else the discovery time
        const since = i.event ? Math.min(i.event.onset_ts, now) - 2 * 3600000 : now - 6 * 3600000;
        const items = news ? news.itemsAsOf(now, { limit: 40, asset: i.symbol }).filter(n => (n.published_ts || n.discovered_ts) >= since && !n.backlog).slice(0, 5) : [];
        i.news_context = { window: i.event ? "since 2 h before the event onset" : "last 6 hours", note: "Possible explanation only: timing coincidence is not causation, and interpretation is rule-based and unevaluated.",
          items: items.map(n => ({ item_id: n.item_id, title: n.title, source: n.source, publisher: n.publisher, url: n.url, published_ts: n.published_ts, discovered_ts: n.discovered_ts, ts_certainty: n.ts_certainty, scope: n.scope,
            stance: (n.interpretations || []).filter(q => q.asset === i.symbol).map(q => q.stance)[0] || null })) };
      }
      return snap;
    },
    newsShadow: (limit = 50) => {
      const rows = store.db.prepare("SELECT s.decision_id, s.analyst, s.instrument_id, s.decision_ts, s.intent, s.risk_outcome, s.verdict, s.would_change, s.overlay_version, s.assessment, p.state AS pos_state, p.pnl AS pos_pnl FROM news_shadow s LEFT JOIN paper_positions p ON p.decision_id = s.decision_id ORDER BY s.decision_ts DESC, s.decision_id LIMIT ?").all(limit)
        .map(r => ({ ...r, assessment: JSON.parse(r.assessment), would_change: !!r.would_change }));
      const by = {}; for (const r of store.db.prepare("SELECT s.verdict, COUNT(*) n, SUM(CASE WHEN p.state='CLOSED' THEN 1 ELSE 0 END) closed, SUM(CASE WHEN p.state='CLOSED' THEN p.pnl ELSE 0 END) net FROM news_shadow s LEFT JOIN paper_positions p ON p.decision_id = s.decision_id GROUP BY s.verdict").all()) by[r.verdict] = { candidates: r.n, closed_positions: r.closed, net_usdt_of_closed: r.net };
      return { schema_version: "news-shadow-v1", overlay_version: require("./news_overlay").VERSION, mode: "SHADOW", effect_on_decisions: "NONE", environment: runtime ? runtime.database.environment : null, rows,
        summary: { by_verdict: by, caveat: "A shadow record annotates what the overlay WOULD have said about each candidate entry; it changed no decision. Counts are small and outcomes are not evidence of benefit until a pre-registered evaluation says so." } };
    },
    news: (o = {}) => {
      if (!news) return { schema_version: "news-v2", items: [], sources: [], counts: null, unavailable: "news ingestion is not running" };
      const now = Date.now(), items = withReaction(store.db, news.itemsAsOf(now, o), now, appliesTo), counts = news.counts(now), sources = news.sourceHealth();
      const ok = sources.filter(s => s.status === "OK").length;
      return { schema_version: "news-v2", parser_version: PARSER_VERSION, as_of: now, environment: runtime ? runtime.database.environment : null,
        coverage: `${NEWS_SOURCES.length} sources: Federal Reserve (3 feeds), SEC press releases, Bitget and OKX exchange announcements. Not comprehensive: no CFTC, ECB, BLS, ETF issuers, Ethereum/Ripple project channels or independent journalism.`,
        note: "context only; interpretations are potential directions from unevaluated keyword rules, not probabilities and not trade signals",
        filters: { limit: o.limit, asset: o.asset || null, source: o.source || null, scope: o.scope || null, all: !!o.all },
        counts, source_summary: { total: sources.length, ok, not_ok: sources.length - ok }, sources,
        interpreters: Object.fromEntries(Object.entries(INTERPRETERS).map(([k, v]) => [k, { enabled: v.enabled, note: v.note }])), items };
    },
    paper: () => getEngine() ? { execution_mode: "PAPER (simulated; no orders are sent anywhere)", accounting_day: "UTC",
      portfolios: getEngine().summary(), open_positions: store.db.prepare("SELECT * FROM paper_positions WHERE state='OPEN' ORDER BY opened_ts").all(),
      recent_closed: store.db.prepare("SELECT * FROM paper_positions WHERE state='CLOSED' ORDER BY exit_ts DESC LIMIT 20").all(),
      recent_decisions: store.db.prepare("SELECT entry_id, created_ts, payload FROM ledger_entries WHERE kind='decision' ORDER BY seq DESC LIMIT 30").all()
        .map(r => ({ entry_id: r.entry_id, created_ts: r.created_ts, ...JSON.parse(r.payload) })) } : { portfolios: [] }
  };
}

async function main() {
  const a = args(process.argv);
  const startedAt = Date.now();
  const log = m => console.log(new Date().toISOString() + " " + m);
  const store = new Store(a.db);
  const identity = store.identity(a.env);
  if (identity.environment !== a.env) throw new Error(`this database belongs to the ${identity.environment} environment; refusing to open it as ${a.env}`);
  const runtime = { build: buildInfo(), instance_id: require("node:crypto").randomUUID(), started_at: startedAt, database: identity, engine_error: null, fixture: null };
  const health = new Health();
  const rest = new BitgetRest();
  const collector = new BitgetCollector({ rest, store, health, symbols: a.symbols, log });
  const ledger = new Ledger(store, { codeRev: gitRev() });
  const engineRef = { current: null };    // the paper engine starts once instruments are loaded
  const news = new NewsIngester({ store, log });
  const monitor = new Monitor({ store, collector, health, getEngine: () => engineRef.current, runtime });
  const stressRef = { current: null };
  const api = buildApi({ store, health, collector, startedAt, ledger, getEngine: () => engineRef.current, news, monitor, runtime, getStress: () => stressRef.current });
  const server = createServer({ api, staticDir: path.join(ROOT, "docs"), port: a.port });

  const filterShadowRef = { current: null };
  const timers = [
    setInterval(() => { try { if (filterShadowRef.current) filterShadowRef.current.resolve(); } catch (e) { log("filter shadow resolve: " + e.message); } }, 60000),
    setInterval(() => { try { store.flush(); } catch (e) { log("flush failed: " + e.message); } }, 250),
    setInterval(async () => { try { const c = await rest.clockOffset(); health.setClock(c.offset_ms, c.rtt_ms); } catch (e) { log("clock: " + e.message); } }, 300000),
    setInterval(() => { collector.finalizeSweep().catch(e => log("finalize: " + e.message)); }, 30000),
    setInterval(() => { try { const r = store.prune(); store.feedEvent("store", "prune", JSON.stringify(r)); } catch (e) { log("prune: " + e.message); } }, 3600000)
  ];
  let stopping = false;
  const shutdown = (code) => {
    if (stopping) return; stopping = true;
    log("shutting down");
    timers.forEach(clearInterval);
    collector.stop(); monitor.stop(); try { if (stressRef.current) stressRef.current.stop(); } catch (e) { log("stress stop: " + e.message); }
    try { if (engineRef.current) engineRef.current.releaseLock(); } catch (e) { /* closing anyway */ }
    server.close();
    try { store.feedEvent("worker", "shutdown", null); store.close(); } catch (e) { log("close: " + e.message); }
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  await new Promise((res, rej) => { server.once("error", rej); server.listen(a.port, "127.0.0.1", res); });
  log(`listening on http://127.0.0.1:${a.port}  environment=${a.env}  build=${runtime.build.revision}${runtime.build.dirty ? "+dirty" : ""}/${runtime.build.source_fingerprint}  instance=${runtime.instance_id.slice(0, 8)}`);
  const prev = store.lastWorkerEvent(), unclean = !!prev && prev.event === "start";
  if (unclean) { store.feedEvent("worker", "unclean_shutdown_detected", "previous run started at " + prev.ts + " and never recorded a shutdown"); log("previous run did not shut down cleanly; downtime recorded as a gap"); }
  store.feedEvent("worker", "start", VERSION);
  await collector.start({ unclean, prevStopTs: prev && prev.event === "shutdown" ? prev.ts : null });
  log(`collecting ${a.symbols.join(", ")} from Bitget public v2`);
  if (a.stress) {
    try {
      const cfg = a.stressFixture ? stressFixture.config(Stress.CONFIG) : Stress.CONFIG;
      stressRef.current = new StressMonitor({ store, collector, health, log, config: cfg, mode: a.stressMode, environment: a.env, synthetic: a.stressFixture ? stressFixture.scenario(cfg, "BTCUSDT") : null });
      stressRef.current.start();
      store.feedEvent("stress", "monitor_start", `${cfg.version} policy=${Stress.POLICY_VERSION} mode=${a.stressMode} calibration=${cfg.calibration.status}${a.stressFixture ? " SYNTHETIC_FIXTURE" : ""}`);
      log(`stress monitor running: ${cfg.version}, policy ${Stress.POLICY_VERSION}, mode ${a.stressMode}, calibration ${cfg.calibration.status}`);
    } catch (e) { runtime.stress_error = e.message; stressRef.current = null; log("stress monitor NOT started: " + e.message); }
  }
  try {
    engineRef.current = new PaperEngine({ store, ledger, collector, health, log, instanceId: runtime.instance_id, environment: a.env, stress: stressRef.current, newsShadow: news ? new NewsShadow({ db: store.db, news, log }) : null, filterShadow: (filterShadowRef.current = new FilterShadow({ db: store.db, ledger, config: require("./risk").RISK_DEFAULTS, environment: a.env, log })) });
    log(`paper engine running (${a.env}): decisions at each 15m bar close; execution mode PAPER`);
  } catch (e) { runtime.engine_error = e.message; log("paper engine NOT started: " + e.message + " (this instance serves data read-only)"); }
  timers.push(setInterval(() => {
    try { collector.checkStalls(); if (engineRef.current) engineRef.current.tick(); }
    catch (e) { log("engine: " + e.message); if (e.constructor && e.constructor.name === "EngineLocked") { runtime.engine_error = e.message; engineRef.current = null; } }
  }, 5000));
  timers.push(setInterval(() => { try { if (engineRef.current) engineRef.current.reconcile(); } catch (e) { log("reconcile: " + e.message); } }, 60000));
  { const rec = new ValuationRecorder({ store, monitor, log }); timers.push(setInterval(() => { if (engineRef.current) rec.tick(); }, 15000)); }   // at most one sample per minute; read-only on trading state
  if (a.fixture && engineRef.current) runtime.fixture = require("./fixture").start({ engine: engineRef.current, collector, store, health, log, identity, timers });
  news.poll().catch(e => log("news: " + e.message));
  timers.push(setInterval(() => { news.poll().catch(e => log("news: " + e.message)); }, 60000));   // each source polls every 10 min

  if (a.smoke) {
    await new Promise(r => setTimeout(r, a.smoke * 1000));
    store.flush();
    const report = await smokeCheck(a.port, collector);
    console.log(JSON.stringify(report, null, 2));
    shutdown(report.pass ? 0 : 1);
  }
}

/** Live smoke: every symbol must have a persisted real trade, ticker and candle, readable via the HTTP API. */
async function smokeCheck(port, collector) {
  const get = async p => (await fetchLocal(port, p));
  const out = { pass: true, checks: [] };
  const ck = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.pass = false; };
  const h = await get("/api/health");
  ck("health data_mode LIVE / ANALYSIS_ONLY", h.data_mode === "LIVE" && h.execution_mode === "ANALYSIS_ONLY", `${h.data_mode}/${h.execution_mode}`);
  ck("socket open", h.socket.state === "open", h.socket.state);
  for (const id of Object.values(collector.idOf)) {
    const t = await get(`/api/trades?instrument=${id}&limit=5`), k = await get(`/api/candles?instrument=${id}&interval=1m&limit=5`),
      tk = await get(`/api/ticker?instrument=${id}`), b = await get(`/api/book?instrument=${id}&levels=5`);
    ck(`${id} trades persisted`, t.trades.length > 0 && t.trades.every(x => x.recv_ts >= x.exch_ts - 5000 && x.persist_ts >= x.recv_ts), `${t.trades.length} rows, latest ${t.trades[0] && t.trades[0].price}`);
    ck(`${id} candles persisted (1m)`, k.candles.length > 0, `${k.candles.length} rows, last final=${k.candles.length && k.candles[k.candles.length - 1].final}`);
    ck(`${id} ticker with distinct last/mark/index`, !!(tk.ticker && tk.ticker.last && tk.ticker.mark && tk.ticker.index_px), tk.ticker ? `last ${tk.ticker.last} mark ${tk.ticker.mark} index ${tk.ticker.index_px} spread ${tk.ticker.spread_bps && tk.ticker.spread_bps.toFixed(3)} bps` : "none");
    ck(`${id} book valid`, b && b.state === "VALID" && b.bids.length > 0 && Number(b.bids[0][0]) < Number(b.asks[0][0]), b && `${b.state} seq ${b.seq} ${b.bids[0] && b.bids[0][0]} / ${b.asks[0] && b.asks[0][0]}`);
  }
  out.health_feeds = h.feeds.map(f => `${f.feed}: ${f.state} age ${f.receipt_age_ms}ms max_gap ${f.max_gap_ms}ms n=${f.messages}`);
  out.clock = h.clock; out.store = h.store;
  return out;
}

function gitRev() {
  try { return require("node:child_process").execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch (e) { return "unknown"; }
}

function fetchLocal(port, p) {
  return new Promise((res, rej) => {
    require("node:http").get({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, r => {
      let s = ""; r.on("data", d => s += d); r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

if (require.main === module) main().catch(e => { console.error("fatal: " + e.message); process.exit(1); });

module.exports = { buildApi, args };
