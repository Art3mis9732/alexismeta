"use strict";
/* News ingestion (news-v2). CONTEXT ONLY: nothing here produces a trading signal, and policies/risk never import it.
 *
 * Pipeline: SOURCE -> FETCH -> VALIDATE -> PARSE -> NORMALIZE -> DEDUPLICATE -> STORE -> INTERPRET -> API -> UI.
 *   FETCH     fixed allowlist of sources (no user URLs, so no SSRF surface); generic client name; 15 s timeout; 2 MB cap;
 *             redirects refused; conditional requests where supported; per-source back-off after failures (longer for 403/429,
 *             e.g. the SEC's "Request Rate Threshold Exceeded" page); one request at a time with spacing.
 *   VALIDATE  RSS must be an <rss> document; JSON must carry the provider's success code and expected shape. Anything else
 *             (e.g. the Fed's HTML "Page not Found" served with HTTP 200) is quarantined, never parsed as news.
 *   PARSE     untrusted text: tags stripped, entities decoded, lengths capped, links must be https on THAT source's host list.
 *   DEDUPE    key = canonical URL. A story carried by several feeds is one row plus a list of source references.
 *   STORE     latest version in news_items; every earlier version in news_revisions with the time it was replaced.
 *   INTERPRET separate append-only table; failures leave the article visible (interpretation unavailable).
 * Source categories: central_bank, regulator (official primary), exchange (interested party). Company/exchange items are
 * claims by an interested party, not independent corroboration. Items first seen in a source's FIRST poll are flagged
 * `backlog`: their discovery time is when we started, not when they were published. */

const crypto = require("node:crypto");
const { ruleInterpreter, validate, INTERPRETER } = require("./news_interpret");

const PARSER_VERSION = "news-parse-v2.1";
const BG = (id, query) => `https://api.bitget.com/api/v2/public/annoucements?language=en_US&limit=10${query}`;
const SOURCES = [
  { id: "fed_press_all", kind: "rss", publisher: "Board of Governors of the Federal Reserve System", category: "central_bank", verification: "OFFICIAL_PRIMARY", language: "en",
    url: "https://www.federalreserve.gov/feeds/press_all.xml", hosts: ["www.federalreserve.gov"], pollMs: 10 * 60000, terms: "Public RSS listed on federalreserve.gov/feeds/feeds.htm" },
  { id: "sec_press", kind: "rss", publisher: "U.S. Securities and Exchange Commission", category: "regulator", verification: "OFFICIAL_PRIMARY", language: "en",
    url: "https://www.sec.gov/news/pressreleases.rss", hosts: ["www.sec.gov"], pollMs: 10 * 60000, terms: "Public RSS; SEC fair-access limits apply (rate-limit page returned when exceeded)" },
  { id: "fed_press_monetary", kind: "rss", publisher: "Board of Governors of the Federal Reserve System", category: "central_bank", verification: "OFFICIAL_PRIMARY", language: "en",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml", hosts: ["www.federalreserve.gov"], pollMs: 10 * 60000, terms: "Public RSS" },
  { id: "fed_speeches", kind: "rss", publisher: "Board of Governors of the Federal Reserve System", category: "central_bank", verification: "OFFICIAL_PRIMARY", language: "en",
    url: "https://www.federalreserve.gov/feeds/speeches_and_testimony.xml", hosts: ["www.federalreserve.gov"], pollMs: 15 * 60000, terms: "Public RSS" },
  { id: "bitget_announcements", kind: "bitget", publisher: "Bitget", category: "exchange", verification: "INTERESTED_PARTY_CLAIM", language: "en",
    url: BG("all", ""), hosts: ["www.bitget.com"], pollMs: 5 * 60000, terms: "Public REST announcements endpoint (api/v2/public/annoucements); limit is capped at 10 per request" },
  { id: "bitget_maintenance", kind: "bitget", publisher: "Bitget", category: "exchange", verification: "INTERESTED_PARTY_CLAIM", language: "en",
    url: BG("maint", "&annType=maintenance_system_updates"), hosts: ["www.bitget.com"], pollMs: 5 * 60000, terms: "Same endpoint, maintenance/system-update type, so outages are not pushed out by listings" },
  { id: "okx_announcements", kind: "okx", publisher: "OKX", category: "exchange", verification: "INTERESTED_PARTY_CLAIM", language: "en",
    url: "https://www.okx.com/api/v5/support/announcements?page=1", hosts: ["www.okx.com"], pollMs: 10 * 60000, terms: "Public REST announcements endpoint (api/v5/support/announcements); secondary venue context only" }
];
const MAX_BYTES = 2 * 1024 * 1024, UA = "alexismeta-research-reader/0.1 (public feeds, low frequency)";

// ------------------------------------------------------------------ text hygiene
const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function clean(s, max) {
  if (s === undefined || s === null) return null;
  let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10) || 32) : (ENT[e.toLowerCase()] ?? m))
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return m ? m[1] : null; };
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/** Canonical URL: https, lower-case host, no fragment, no tracking parameters, no trailing slash. null if unusable. */
function canonicalUrl(u) {
  try {
    const x = new URL(u); if (x.protocol !== "https:") return null;
    x.hash = ""; x.hostname = x.hostname.toLowerCase();
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) x.searchParams.delete(k);
    let s = x.toString(); if (x.pathname.length > 1 && s.endsWith("/") && !x.search) s = s.slice(0, -1);
    return s;
  } catch (e) { return null; }
}
/** Link safety: https and an exact host from THIS source's allowlist (hosts === null: legacy any .gov/.org/.com check). */
function linkOk(u, hosts) {
  const c = canonicalUrl(u); if (!c) return null;
  const h = new URL(c).hostname;
  if (hosts) return hosts.includes(h) ? c : null;
  return /\.(gov|org|com)$/.test(h) ? c : null;
}

// ------------------------------------------------------------------ parsers: each returns { ok, items } | { ok:false, reason }
function parseRss(text, hosts = null) {
  if (typeof text !== "string") return { ok: false, reason: "not text" };
  const body = text.replace(/^﻿/, "").trimStart();
  if (!/^<\?xml[\s\S]{0,200}?<rss[\s>]/i.test(body) && !/^<rss[\s>]/i.test(body)) return { ok: false, reason: "not an RSS document (root is not <rss>)" };
  const blocks = body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  if (!blocks.length) return { ok: false, reason: "RSS without items" };
  const items = [];
  for (const b of blocks.slice(0, 200)) {
    const title = clean(tag(b, "title"), 300), link = clean(tag(b, "link"), 500), guid = clean(tag(b, "guid"), 500) || link;
    const url = link && linkOk(link, hosts);
    if (!title || !url) continue;
    const pd = clean(tag(b, "pubDate"), 80), ts = pd ? Date.parse(pd) : NaN;
    items.push({ guid, url, title, summary: clean(tag(b, "description"), 600), published_ts: Number.isFinite(ts) ? ts : null, meta: {} });
  }
  return items.length ? { ok: true, items } : { ok: false, reason: "no valid items" };
}
function parseJson(text) { try { return { ok: true, j: JSON.parse(text) }; } catch (e) { return { ok: false, reason: "not JSON" }; } }
function msTs(v) { const n = Number(v); return Number.isFinite(n) && n > Date.UTC(2017, 0, 1) && n < Date.now() + 86400000 ? n : null; }
function parseBitget(text, hosts = null) {
  const p = parseJson(text); if (!p.ok) return p; const j = p.j;
  if (!j || String(j.code) !== "00000") return { ok: false, reason: `provider error code ${j && j.code}: ${clean(j && j.msg, 120)}` };
  if (!Array.isArray(j.data) || !j.data.length) return { ok: false, reason: "no announcements in response" };
  const items = [];
  for (const a of j.data.slice(0, 100)) {
    const title = clean(a && a.annTitle, 300), url = a && a.annUrl && linkOk(a.annUrl, hosts);
    if (!title || !url || !a.annId) continue;
    items.push({ guid: String(a.annId), url, title, summary: null, published_ts: msTs(a.cTime), meta: { annType: clean(a.annType, 60), annSubType: clean(a.annSubType, 60) } });
  }
  return items.length ? { ok: true, items } : { ok: false, reason: "no valid items" };
}
function parseOkx(text, hosts = null) {
  const p = parseJson(text); if (!p.ok) return p; const j = p.j;
  if (!j || String(j.code) !== "0") return { ok: false, reason: `provider error code ${j && j.code}: ${clean(j && j.msg, 120)}` };
  const det = j.data && j.data[0] && j.data[0].details;
  if (!Array.isArray(det) || !det.length) return { ok: false, reason: "no announcements in response" };
  const items = [];
  for (const a of det.slice(0, 100)) {
    const title = clean(a && a.title, 300), url = a && a.url && linkOk(a.url, hosts);
    if (!title || !url) continue;
    items.push({ guid: url, url, title, summary: null, published_ts: msTs(a.pTime), meta: { annType: clean(a.annType, 80) } });
  }
  return items.length ? { ok: true, items } : { ok: false, reason: "no valid items" };
}
const PARSERS = { rss: parseRss, bitget: parseBitget, okx: parseOkx };

// ------------------------------------------------------------------ deterministic classification
const NAME_RULES = [["BTC", /\b(bitcoin|btc)\b/i], ["ETH", /\b(ether|ethereum|eth)\b/i], ["XRP", /\b(xrp|ripple)\b/i],
  ["crypto", /\b(crypto|cryptocurrenc\w*|digital asset\w*|stablecoin\w*|blockchain)\b/i]];   // "tokenized" alone is NOT crypto (tokenized equities/funds)
const TICKER_RULES = [["BTC", /\b(BTC)(\/?USDT)?\b/], ["ETH", /\b(ETH)(\/?USDT)?\b/], ["XRP", /\b(XRP)(\/?USDT)?\b/]];
const EVENT_RULES = [["monetary_policy", /\b(fomc|federal open market committee|monetary policy|interest rate|federal funds|discount rate|balance sheet|primary credit)\b/i],
  ["etf", /\b(exchange[- ]traded|etf|etp)\b/i], ["enforcement", /\b(charge[sd]?|settle[sd]?|fraud|enforcement|penalt\w*|lawsuit|complaint|barred|sanction\w*)\b/i],
  ["rulemaking", /\b(propos\w*|final rule|rule amendments?|comment period|guidance|interpretive|request for comment)\b/i],
  ["stablecoin", /\bstablecoin\w*\b/i], ["custody", /\bcustod\w*\b/i], ["speech_testimony", /\b(speech|testimony|remarks|statement by)\b/i]];
const EXCH_TYPES = { coin_listings: "exchange_listing", maintenance_system_updates: "exchange_maintenance", product_updates: "exchange_product",
  "announcements-new-listings": "exchange_listing", "announcements-delistings": "exchange_delisting", "announcements-api": "exchange_api" };
const VENUE_OPS = /\b(futures|perpetual|usdt-m|system (upgrade|maintenance)|api|websocket|matching|trading (suspension|halt)|outage|incident)\b/i;

/** ctx = { category, meta } from the source. Returns { assets, event_type, scope }. */
function classify(title, summary, ctx = {}) {
  const t = `${title} ${summary || ""}`, exch = ctx.category === "exchange";
  const assets = exch ? TICKER_RULES.filter(([, re]) => re.test(t)).map(([a]) => a) : NAME_RULES.filter(([, re]) => re.test(t)).map(([a]) => a);
  const ev = new Set(EVENT_RULES.filter(([, re]) => !exch && re.test(t)).map(([e]) => e));
  if (exch) {
    const m = ctx.meta || {}, typed = EXCH_TYPES[m.annType] || (m.annType && m.annType.startsWith("trading-updates") ? "exchange_product" : null);
    if (typed) ev.add(typed);
    if (/\bdelist\w*/i.test(t)) { ev.delete("exchange_listing"); ev.add("exchange_delisting"); }
    if (m.annSubType && /maintenance/.test(m.annSubType)) ev.add("exchange_maintenance");
  }
  const event_type = ev.size ? [...ev].join(",") : "other";
  let scope = "OTHER";
  if (assets.length) scope = "ASSET";
  else if (ctx.category === "central_bank" && ev.has("monetary_policy")) scope = "MACRO";
  else if (ctx.category === "central_bank" && ev.has("speech_testimony")) scope = "MACRO";
  else if (exch && ev.has("exchange_maintenance") && VENUE_OPS.test(t) && /bitget/i.test(ctx.publisher || "")) scope = "EXCHANGE_OPS";
  else if (exch && /bitget/i.test(ctx.publisher || "") && ev.has("exchange_api")) scope = "EXCHANGE_OPS";
  else if (exch) scope = "UNRELATED_LISTING";
  return { assets, event_type, scope };
}
const clusterOf = title => sha(title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|a|an|of|and|to|for|on|in)\b/g, " ").replace(/\s+/g, " ").trim()).slice(0, 16);
const RELEVANT_SCOPES = ["ASSET", "MACRO", "EXCHANGE_OPS"];

class NewsIngester {
  constructor({ store, fetchImpl = globalThis.fetch, now = Date.now, sources = SOURCES, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), spacingMs = 1000 }) {
    Object.assign(this, { store, fetchImpl, now, sources, log, sleep, spacingMs }); this.db = store.db; this.state = {};
    for (const s of sources) this.state[s.id] = { last_poll_ts: null, last_ok_ts: null, last_error: null, last_http: null, etag: null, last_modified: null, items_seen: 0, consecutive_failures: 0, backoff_until: 0 };
    this.restoreState(); this.backfillClassification();
  }

  /** Source health survives restarts: restore from the fetch log (cadence, last success, failure streak). */
  restoreState() {
    for (const s of this.sources) {
      const st = this.state[s.id], last = this.db.prepare("SELECT * FROM news_fetch_log WHERE source=? ORDER BY id DESC LIMIT 1").get(s.id);
      if (!last) continue;
      st.last_poll_ts = last.ts; st.last_http = last.http_status; if (!last.ok) st.last_error = last.error;
      const ok = this.db.prepare("SELECT MAX(ts) AS t FROM news_fetch_log WHERE source=? AND ok=1").get(s.id);
      st.last_ok_ts = ok && ok.t !== null ? ok.t : null;
      let n = 0; for (const r of this.db.prepare("SELECT ok FROM news_fetch_log WHERE source=? ORDER BY id DESC LIMIT 10").all(s.id)) { if (r.ok) break; n++; }
      st.consecutive_failures = n;
    }
  }

  /** Derived columns (assets, event type, scope) for rows that predate the current parser version. Original text is untouched. */
  backfillClassification() {
    const rows = this.db.prepare("SELECT item_id, source, title, summary FROM news_items WHERE parser_version IS NULL OR parser_version <> ?").all(PARSER_VERSION);
    if (!rows.length) return 0;
    this.store.tx(() => { for (const r of rows) {
      const src = this.sources.find(s => s.id === r.source) || {}, c = classify(r.title, r.summary, { category: src.category, publisher: src.publisher, meta: {} });
      this.db.prepare("UPDATE news_items SET assets=?, event_type=?, scope=?, parser_version=? WHERE item_id=?").run(JSON.stringify(c.assets), c.event_type, c.scope, PARSER_VERSION, r.item_id);
      this.interpret(r.item_id);                                                 // new run under the current interpreter; earlier rows stay as history
    } });
    return rows.length;
  }

  async fetchText(src) {
    const headers = { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9, application/json;q=0.9, text/xml;q=0.8" };
    const st = this.state[src.id]; if (st.etag) headers["If-None-Match"] = st.etag; if (st.last_modified) headers["If-Modified-Since"] = st.last_modified;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await this.fetchImpl(src.url, { headers, redirect: "manual", signal: ac.signal });
      st.last_http = r.status;
      if (r.status === 304) return { notModified: true, status: 304 };
      if (r.status >= 300 && r.status < 400) throw Object.assign(new Error(`redirect refused (HTTP ${r.status})`), { status: r.status });
      if (r.status !== 200) {
        let hint = ""; try { const b = await r.text(); const m = String(b).match(/<title>([^<]{0,80})<\/title>/i); if (m) hint = ` (${clean(m[1], 80)})`; } catch (e) { /* body unreadable */ }
        throw Object.assign(new Error(`HTTP ${r.status}${hint}`), { status: r.status });
      }
      const len = Number(r.headers && r.headers.get ? r.headers.get("content-length") : 0);
      if (len > MAX_BYTES) throw new Error("response too large");
      const text = await r.text();
      if (text.length > MAX_BYTES) throw new Error("response too large");
      if (r.headers && r.headers.get) { st.etag = r.headers.get("etag") || null; st.last_modified = r.headers.get("last-modified") || null; }
      return { text, status: 200 };
    } finally { clearTimeout(timer); }
  }

  /** Ingest one document for one source. Returns counts. Used by poll() and by tests with captured fixtures. */
  ingest(src, text) {
    const parse = PARSERS[src.kind || "rss"], p = parse(text, src.hosts || null), t = this.now();
    if (!p.ok) { this.store.quarantine("news:" + src.id, p.reason, String(text).slice(0, 2000)); return { ok: false, reason: p.reason }; }
    const firstPoll = this.db.prepare("SELECT COUNT(*) AS n FROM news_items WHERE source=?").get(src.id).n === 0;
    let added = 0, revised = 0, linked = 0, interpFailed = 0;
    this.store.tx(() => {
      for (const it of p.items) {
        const canon = canonicalUrl(it.url), c = classify(it.title, it.summary, { category: src.category, publisher: src.publisher, meta: it.meta }), hash = sha(it.title + "|" + (it.summary || ""));
        const cur = this.db.prepare("SELECT * FROM news_items WHERE canonical_url=?").get(canon);
        let id;
        if (!cur) {
          id = sha(canon).slice(0, 32);
          this.db.prepare(`INSERT INTO news_items (item_id, source, publisher, url, title, summary, published_ts, discovered_ts, updated_ts, event_type, assets, credibility, cluster_id, content_hash,
              canonical_url, language, source_category, ts_certainty, verification, scope, backlog, refs, parser_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, src.id, src.publisher, it.url, it.title, it.summary, it.published_ts, t, t, c.event_type, JSON.stringify(c.assets), src.verification === "OFFICIAL_PRIMARY" ? "official_primary" : "interested_party",
              clusterOf(it.title), hash, canon, src.language || "en", src.category, it.published_ts === null ? "UNKNOWN" : "SOURCE_STATED", src.verification, c.scope, firstPoll ? 1 : 0,
              JSON.stringify([{ source: src.id, guid: it.guid, first_seen_ts: t }]), PARSER_VERSION);
          added++;
        } else {
          id = cur.item_id;
          const refs = JSON.parse(cur.refs || "[]");
          if (!refs.some(r => r.source === src.id)) { refs.push({ source: src.id, guid: it.guid, first_seen_ts: t }); this.db.prepare("UPDATE news_items SET refs=? WHERE item_id=?").run(JSON.stringify(refs), id); linked++; }
          if (cur.source === src.id && cur.content_hash !== hash) {                  // the primary publisher changed the item: keep the old version
            this.db.prepare("INSERT INTO news_revisions (item_id, replaced_ts, title, summary, content_hash) VALUES (?,?,?,?,?)").run(id, t, cur.title, cur.summary, cur.content_hash);
            this.db.prepare("UPDATE news_items SET title=?, summary=?, updated_ts=?, event_type=?, assets=?, scope=?, content_hash=?, cluster_id=?, parser_version=? WHERE item_id=?")
              .run(it.title, it.summary, t, c.event_type, JSON.stringify(c.assets), c.scope, hash, clusterOf(it.title), PARSER_VERSION, id); revised++;
          } else if (cur.source !== src.id) continue;                                // a secondary source repeating a known story: reference only
        }
        if (!this.interpret(id)) interpFailed++;
      }
    });
    return { ok: true, items: p.items.length, added, revised, linked, interpretation_failed: interpFailed };
  }

  /** Interpret the CURRENT version of one item; append-only. A failure never affects the article. */
  interpret(itemId) {
    const row = this.db.prepare("SELECT * FROM news_items WHERE item_id=?").get(itemId); if (!row) return false;
    try {
      const item = { ...row, assets: JSON.parse(row.assets) }, res = validate(ruleInterpreter(item)), t = this.now();
      this.db.prepare("INSERT OR IGNORE INTO news_interpretation_runs (item_id, content_hash, interpreter, created_ts, n_assets) VALUES (?,?,?,?,?)").run(itemId, row.content_hash, res.interpreter, t, res.per_asset.length);
      for (const p of res.per_asset) this.db.prepare(`INSERT OR IGNORE INTO news_interpretations (item_id, content_hash, interpreter, created_ts, asset, stance, kind, mechanism, horizon, supporting, contradicting, limitations, rule_ids)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, row.content_hash, res.interpreter, t, p.asset, p.stance, p.kind, p.mechanism || null, p.horizon || null,
        JSON.stringify(p.supporting), JSON.stringify(p.contradicting), JSON.stringify(p.limitations), JSON.stringify(p.rule_ids));
      return true;
    } catch (e) { this.store.feedEvent("news:interpret", "interpretation_failed", `${itemId}: ${e.message}`); return false; }
  }

  logFetch(src, r) { this.db.prepare("INSERT INTO news_fetch_log (source, ts, ok, http_status, items, added, revised, error, latency_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(src.id, this.now(), r.ok ? 1 : 0, r.status === undefined ? null : r.status, r.items === undefined ? null : r.items, r.added === undefined ? null : r.added, r.revised === undefined ? null : r.revised, r.error || null, r.latency || null); }

  async poll(force = false) {
    const out = {};
    for (const src of this.sources) {
      const st = this.state[src.id], t = this.now();
      if (!force && st.last_poll_ts !== null && t - st.last_poll_ts < src.pollMs) continue;
      if (!force && st.backoff_until > t) { out[src.id] = { ok: false, skipped: "backoff", until: st.backoff_until }; continue; }
      if (Object.keys(out).length && this.spacingMs) await this.sleep(this.spacingMs);          // one request at a time, politely spaced
      st.last_poll_ts = this.now();
      const t0 = Date.now();
      try {
        const r = await this.fetchText(src);
        out[src.id] = r.notModified ? { ok: true, notModified: true } : this.ingest(src, r.text);
        if (out[src.id].ok) { st.last_ok_ts = this.now(); st.last_error = null; st.consecutive_failures = 0; st.backoff_until = 0; if (!r.notModified) st.items_seen = out[src.id].items; }
        else { st.last_error = out[src.id].reason; this.fail(st, src, null); }
        this.logFetch(src, { ok: out[src.id].ok, status: r.status, items: out[src.id].items, added: out[src.id].added, revised: out[src.id].revised, error: out[src.id].ok ? null : out[src.id].reason, latency: Date.now() - t0 });
      } catch (e) {
        st.last_error = e.message; this.fail(st, src, e.status); out[src.id] = { ok: false, reason: e.message };
        this.store.feedEvent("news:" + src.id, "fetch_failed", e.message);
        this.logFetch(src, { ok: false, status: e.status === undefined ? null : e.status, error: e.message, latency: Date.now() - t0 });
      }
    }
    return out;
  }
  /** Bounded exponential back-off per source; 403/429 (rate limiting) waits at least 30 minutes. Never hammers a source that said no. */
  fail(st, src, status) {
    st.consecutive_failures++;
    let wait = Math.min(2 * 3600000, src.pollMs * Math.pow(2, st.consecutive_failures - 1));
    if (status === 403 || status === 429) wait = Math.max(wait, 30 * 60000);
    st.backoff_until = this.now() + wait;
  }

  // ------------------------------------------------------------------ reads
  sourceHealth() {
    const t = this.now();
    return this.sources.map(s => {
      const st = this.state[s.id], lagRows = this.db.prepare("SELECT discovered_ts - published_ts AS lag FROM news_items WHERE source=? AND backlog=0 AND published_ts IS NOT NULL ORDER BY discovered_ts DESC LIMIT 50").all(s.id).map(r => r.lag).filter(x => x >= 0).sort((a, b) => a - b);
      const newest = this.db.prepare("SELECT MAX(published_ts) AS p, COUNT(*) AS n FROM news_items WHERE source=?").get(s.id);
      const status = st.last_poll_ts === null ? "NOT_YET_POLLED" : st.backoff_until > t ? (st.last_http === 403 || st.last_http === 429 ? "RATE_LIMITED_BACKOFF" : "BACKOFF") : st.consecutive_failures >= 3 || st.last_ok_ts === null ? "FAILING"
        : t - st.last_ok_ts > 2.5 * s.pollMs ? "STALE" : st.last_error ? "DEGRADED" : "OK";
      return { source: s.id, publisher: s.publisher, category: s.category, verification: s.verification, language: s.language, url_host: new URL(s.url).hostname, terms: s.terms, cadence: `polled every ${s.pollMs / 60000} min (not a push feed)`,
        poll_every_ms: s.pollMs, status, last_fetch_ts: st.last_poll_ts, last_ok_ts: st.last_ok_ts, fetch_age_ms: st.last_ok_ts === null ? null : t - st.last_ok_ts, last_error: st.last_error, last_http: st.last_http, consecutive_failures: st.consecutive_failures,
        backoff_until: st.backoff_until > t ? st.backoff_until : null, items_stored: newest.n, newest_item_published_ts: newest.p, newest_item_age_ms: newest.p === null ? null : t - newest.p,
        median_discovery_lag_ms: lagRows.length ? lagRows[Math.floor(lagRows.length / 2)] : null, discovery_lag_samples: lagRows.length,
        note: "source freshness = how recently we successfully fetched it; item age = how old its newest item is. A quiet source can be healthy." };
    });
  }
  status() { return this.sourceHealth(); }

  /** Items known at `asOf` (point in time). Filters are applied in SQL BEFORE the limit. */
  itemsAsOf(asOf, { limit = 30, asset = null, scope = null, source = null, all = false } = {}) {
    const w = ["discovered_ts <= ?"], a = [asOf];
    if (!all && !scope) w.push(`scope IN (${RELEVANT_SCOPES.map(() => "?").join(",")})`), a.push(...RELEVANT_SCOPES);
    if (scope) { w.push("scope = ?"); a.push(scope); }
    if (source) { w.push("source = ?"); a.push(source); }
    if (asset) { w.push("(scope IN ('MACRO','EXCHANGE_OPS') OR assets LIKE ? OR assets LIKE '%\"crypto\"%')"); a.push(`%"${asset}"%`); }
    const rows = this.db.prepare(`SELECT * FROM news_items WHERE ${w.join(" AND ")} ORDER BY COALESCE(published_ts, discovered_ts) DESC LIMIT ?`).all(...a, limit);
    return rows.map(r => this.view(r, asOf));
  }
  view(r, asOf) {
    let v = { ...r };
    if (r.updated_ts > asOf) {                                                      // a later revision exists: show the version current at asOf
      const old = this.db.prepare("SELECT * FROM news_revisions WHERE item_id=? AND replaced_ts > ? ORDER BY replaced_ts ASC LIMIT 1").get(r.item_id, asOf);
      if (old) v = { ...v, title: old.title, summary: old.summary, content_hash: old.content_hash, revised_later: true };
    }
    v.assets = JSON.parse(v.assets); v.refs = JSON.parse(v.refs || "[]"); v.backlog = !!v.backlog;
    const run = this.db.prepare("SELECT * FROM news_interpretation_runs WHERE item_id=? AND content_hash=? AND created_ts <= ? ORDER BY created_ts DESC, id DESC LIMIT 1").get(r.item_id, v.content_hash, asOf);
    const interp = !run || run.n_assets === 0 ? [] : this.db.prepare("SELECT * FROM news_interpretations WHERE item_id=? AND content_hash=? AND interpreter=? AND created_ts <= ? ORDER BY id").all(r.item_id, v.content_hash, run.interpreter, asOf)
      .map(x => ({ asset: x.asset, stance: x.stance, kind: x.kind, mechanism: x.mechanism, horizon: x.horizon, supporting: JSON.parse(x.supporting), contradicting: JSON.parse(x.contradicting), limitations: JSON.parse(x.limitations), rule_ids: JSON.parse(x.rule_ids), interpreter: x.interpreter }));
    const cluster = this.db.prepare("SELECT COUNT(*) AS n FROM news_items WHERE cluster_id=? AND discovered_ts <= ?").get(r.cluster_id, asOf).n;
    const revs = this.db.prepare("SELECT COUNT(*) AS n FROM news_revisions WHERE item_id=? AND replaced_ts <= ?").get(r.item_id, asOf).n;
    const { content_hash, canonical_url, parser_version, ...rest } = v;
    return { ...rest, canonical_url, revisions_known: revs, cluster_size: cluster, discovery_lag_ms: v.backlog || v.published_ts === null ? null : v.discovered_ts - v.published_ts,
      interpretations: interp, interpretation_status: interp.length ? "AVAILABLE" : (run && run.n_assets === 0 ? "NOT_APPLICABLE" : (!run && ["ASSET", "MACRO", "EXCHANGE_OPS"].includes(v.scope) ? "UNAVAILABLE" : "NOT_APPLICABLE")),
      interpreter_version: run ? run.interpreter : null,
      note: "context only; not a trading signal" };
  }
  counts(asOf = this.now()) {
    const byScope = Object.fromEntries(this.db.prepare("SELECT scope, COUNT(*) n FROM news_items WHERE discovered_ts <= ? GROUP BY scope").all(asOf).map(r => [r.scope, r.n]));
    const total = Object.values(byScope).reduce((a, b) => a + b, 0), relevant = RELEVANT_SCOPES.reduce((s, k) => s + (byScope[k] || 0), 0);
    return { total, relevant, hidden_not_relevant: total - relevant, by_scope: byScope, backlog: this.db.prepare("SELECT COUNT(*) n FROM news_items WHERE backlog=1").get().n };
  }
}

module.exports = { NewsIngester, SOURCES, PARSER_VERSION, parseRss, parseBitget, parseOkx, classify, clean, clusterOf, canonicalUrl, linkOk, RELEVANT_SCOPES, INTERPRETER };
