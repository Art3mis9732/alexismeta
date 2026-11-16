"use strict";
/* Official-source news ingestion (Phase 6, first slice). CONTEXT ONLY: nothing here produces a trading signal.
 *
 * Sources are a FIXED allowlist (no user-supplied URLs -> no SSRF surface). Each poll:
 *   - GET with a generic client name (no personal contact details), 15 s timeout, 2 MB cap, redirects refused
 *   - content must be RSS 2.0 (`<rss` root with `<item>`s); anything else (e.g. the Fed's intermittent HTML
 *     "Page not Found" served with HTTP 200) is quarantined, never parsed as news
 *   - items are untrusted text: tags stripped, entities decoded, lengths capped; they are stored and displayed as
 *     data, never executed or fed to a model. Instructions inside an article have no effect on anything.
 * Stored per item: canonical URL, publisher, published time (feed pubDate, may be null), discovery time (first seen
 * here), updated time + revision history, deterministic event type and asset tags, credibility "official_primary",
 * and a cluster id (normalised title) so syndicated copies across sources are not counted as confirmation.
 * Interpretation (bullish/bearish, "priced in") is deliberately absent. */

const crypto = require("node:crypto");

const SOURCES = [
  { id: "fed_press_all", publisher: "Board of Governors of the Federal Reserve System", url: "https://www.federalreserve.gov/feeds/press_all.xml", pollMs: 10 * 60000 },
  { id: "sec_press", publisher: "U.S. Securities and Exchange Commission", url: "https://www.sec.gov/news/pressreleases.rss", pollMs: 10 * 60000 }
];
const MAX_BYTES = 2 * 1024 * 1024, UA = "alexismeta-research-reader/0.1 (public RSS, low frequency)";

const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function clean(s, max) {
  if (s === undefined || s === null) return null;
  let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10) || 32) : (ENT[e.toLowerCase()] ?? m))
    .replace(/<[^>]*>/g, " ")                                   // tags that were entity-encoded
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return m ? m[1] : null; };

/** Parse RSS 2.0 text. Returns { ok, items } or { ok:false, reason }. */
function parseRss(text) {
  if (typeof text !== "string") return { ok: false, reason: "not text" };
  const body = text.replace(/^﻿/, "").trimStart();
  if (!/^<\?xml[\s\S]{0,200}?<rss[\s>]/i.test(body) && !/^<rss[\s>]/i.test(body)) return { ok: false, reason: "not an RSS document (root is not <rss>)" };
  const blocks = body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  if (!blocks.length) return { ok: false, reason: "RSS without items" };
  const items = [];
  for (const b of blocks.slice(0, 200)) {
    const title = clean(tag(b, "title"), 300), link = clean(tag(b, "link"), 500), guid = clean(tag(b, "guid"), 500) || link;
    if (!title || !link || !/^https:\/\/[a-z0-9.-]+\.(gov|org|com)\//i.test(link)) continue;   // official https links only
    const pd = clean(tag(b, "pubDate"), 80), ts = pd ? Date.parse(pd) : NaN;
    items.push({ guid, url: link, title, summary: clean(tag(b, "description"), 600), published_ts: Number.isFinite(ts) ? ts : null });
  }
  return items.length ? { ok: true, items } : { ok: false, reason: "no valid items" };
}

/* Deterministic tagging. Keyword rules only; an item can carry several asset tags; "crypto" = crypto in general. */
const ASSET_RULES = [["BTC", /\b(bitcoin|btc)\b/i], ["ETH", /\b(ether|ethereum|eth)\b/i], ["XRP", /\b(xrp|ripple)\b/i],
  ["crypto", /\b(crypto|cryptocurrenc\w*|digital asset\w*|stablecoin\w*|blockchain|tokeni[sz]\w*)\b/i]];
const EVENT_RULES = [["monetary_policy", /\b(fomc|federal open market committee|monetary policy|interest rate|federal funds|discount rate|balance sheet)\b/i],
  ["etf", /\b(exchange[- ]traded|etf|etp)\b/i], ["enforcement", /\b(charge[sd]?|settle[sd]?|fraud|enforcement|penalt\w*|lawsuit|complaint|barred|sanction\w*)\b/i],
  ["rulemaking", /\b(propos\w*|final rule|rule amendments?|comment period|guidance|interpretive|request for comment)\b/i],
  ["stablecoin", /\bstablecoin\w*\b/i], ["custody", /\bcustod\w*\b/i], ["speech_testimony", /\b(speech|testimony|remarks|statement by)\b/i]];
function classify(title, summary) {
  const t = `${title} ${summary || ""}`;
  const assets = ASSET_RULES.filter(([, re]) => re.test(t)).map(([a]) => a);
  const ev = EVENT_RULES.filter(([, re]) => re.test(t)).map(([e]) => e);
  return { assets, event_type: ev.length ? ev.join(",") : "other" };
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const clusterOf = title => sha(title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|a|an|of|and|to|for|on|in)\b/g, " ").replace(/\s+/g, " ").trim()).slice(0, 16);

class NewsIngester {
  constructor({ store, fetchImpl = globalThis.fetch, now = Date.now, sources = SOURCES, log = () => {} }) {
    Object.assign(this, { store, fetchImpl, now, sources, log }); this.state = {}; this.db = store.db;
    for (const s of sources) this.state[s.id] = { last_poll_ts: null, last_ok_ts: null, last_error: null, etag: null, last_modified: null, items_seen: 0 };
  }

  async fetchText(src) {
    const headers = { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" };
    const st = this.state[src.id]; if (st.etag) headers["If-None-Match"] = st.etag; if (st.last_modified) headers["If-Modified-Since"] = st.last_modified;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await this.fetchImpl(src.url, { headers, redirect: "manual", signal: ac.signal });
      if (r.status === 304) return { notModified: true };
      if (r.status >= 300 && r.status < 400) throw new Error(`redirect refused (HTTP ${r.status})`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const len = Number(r.headers && r.headers.get ? r.headers.get("content-length") : 0);
      if (len > MAX_BYTES) throw new Error("response too large");
      const text = await r.text();
      if (text.length > MAX_BYTES) throw new Error("response too large");
      if (r.headers && r.headers.get) { st.etag = r.headers.get("etag") || null; st.last_modified = r.headers.get("last-modified") || null; }
      return { text };
    } finally { clearTimeout(timer); }
  }

  /** Ingest one parsed document. Returns counts. Exported path used by tests and by poll(). */
  ingest(src, text) {
    const p = parseRss(text), t = this.now();
    if (!p.ok) { this.store.quarantine("news:" + src.id, p.reason, text.slice(0, 2000)); return { ok: false, reason: p.reason }; }
    let added = 0, revised = 0;
    for (const it of p.items) {
      const id = sha(src.id + "|" + it.guid).slice(0, 32), c = classify(it.title, it.summary), hash = sha(it.title + "|" + (it.summary || ""));
      const cur = this.db.prepare("SELECT * FROM news_items WHERE item_id=?").get(id);
      if (!cur) {
        this.db.prepare(`INSERT INTO news_items (item_id, source, publisher, url, title, summary, published_ts, discovered_ts, updated_ts, event_type, assets, credibility, cluster_id, content_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, src.id, src.publisher, it.url, it.title, it.summary, it.published_ts, t, t, c.event_type, JSON.stringify(c.assets),
          "official_primary", clusterOf(it.title), hash);
        added++;
      } else if (cur.content_hash !== hash) {                      // the publisher changed the item: keep the old version
        this.db.prepare("INSERT INTO news_revisions (item_id, replaced_ts, title, summary, content_hash) VALUES (?,?,?,?,?)").run(id, t, cur.title, cur.summary, cur.content_hash);
        this.db.prepare("UPDATE news_items SET title=?, summary=?, updated_ts=?, event_type=?, assets=?, content_hash=?, cluster_id=? WHERE item_id=?")
          .run(it.title, it.summary, t, c.event_type, JSON.stringify(c.assets), hash, clusterOf(it.title), id);
        revised++;
      }
    }
    this.state[src.id].items_seen = p.items.length;
    return { ok: true, items: p.items.length, added, revised };
  }

  async poll(force = false) {
    const out = {};
    for (const src of this.sources) {
      const st = this.state[src.id], t = this.now();
      if (!force && st.last_poll_ts !== null && t - st.last_poll_ts < src.pollMs) continue;
      st.last_poll_ts = t;
      try {
        const r = await this.fetchText(src);
        out[src.id] = r.notModified ? { ok: true, notModified: true } : this.ingest(src, r.text);
        if (out[src.id].ok) { st.last_ok_ts = t; st.last_error = null; } else st.last_error = out[src.id].reason;
      } catch (e) { st.last_error = e.message; out[src.id] = { ok: false, reason: e.message }; this.store.feedEvent("news:" + src.id, "fetch_failed", e.message); }
    }
    return out;
  }

  /** Items known at time `asOf` (point in time): discovered by then, with the version that was current then. */
  itemsAsOf(asOf, { limit = 30, asset = null } = {}) {
    const rows = this.db.prepare("SELECT * FROM news_items WHERE discovered_ts <= ? ORDER BY COALESCE(published_ts, discovered_ts) DESC LIMIT ?").all(asOf, limit * 3);
    const out = [];
    for (const r of rows) {
      let v = { ...r };
      if (r.updated_ts > asOf) {                                   // a later revision exists: show the version current at asOf
        const old = this.db.prepare("SELECT * FROM news_revisions WHERE item_id=? AND replaced_ts > ? ORDER BY replaced_ts ASC LIMIT 1").get(r.item_id, asOf);
        if (old) v = { ...v, title: old.title, summary: old.summary, content_hash: old.content_hash, revised_later: true };
      }
      v.assets = JSON.parse(v.assets);
      if (asset && !v.assets.includes(asset) && !v.assets.includes("crypto")) continue;
      const revs = this.db.prepare("SELECT COUNT(*) n FROM news_revisions WHERE item_id=? AND replaced_ts <= ?").get(r.item_id, asOf).n;
      out.push({ ...v, revisions_known: revs, interpretation: null, note: "official source; context only; not a trading signal" });
      if (out.length >= limit) break;
    }
    return out;
  }

  status() { return this.sources.map(s => ({ source: s.id, publisher: s.publisher, url: s.url, poll_every_min: s.pollMs / 60000, ...this.state[s.id] })); }
}

module.exports = { NewsIngester, SOURCES, parseRss, classify, clean, clusterOf };
