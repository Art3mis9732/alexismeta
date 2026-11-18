"use strict";
/* Static news snapshot for the PUBLIC site (GitHub Pages cannot run the worker). Built by a scheduled job with the SAME ingester, classifier and interpreter the worker uses.
 *
 * What a snapshot is and is not:
 *  - it is a periodic copy of official feeds with the rule-based interpretation attached; it is only as fresh as the job that publishes it (hours, not seconds);
 *  - "discovered" is the time of the first SNAPSHOT that saw the item (the previous snapshot is carried over as memory); the very first snapshot cannot know, so its items are marked backlog;
 *  - there is NO price reaction here (no candle store); that needs the local worker. Nothing is simulated or back-filled. */
const { Store } = require("./store"), { NewsIngester, SOURCES } = require("./news");
const SCHEMA = "news-snapshot-v1", KEEP = 200;

/** @param {{prev:object|null, now:number, fetchImpl?:Function, sources?:object[], spacingMs?:number, log?:Function}} o */
async function buildSnapshot({ prev, now, fetchImpl = globalThis.fetch, sources = SOURCES, spacingMs = 1000, log = () => {} }) {
  const store = new Store(":memory:", { now: () => now }), ing = new NewsIngester({ store, fetchImpl, now: () => now, sources, spacingMs, log });
  await ing.poll(true);
  const fresh = ing.itemsAsOf(now, { limit: 500 }), prevItems = new Map(((prev && prev.items) || []).map(i => [i.item_id, i])), hadPrev = !!(prev && Array.isArray(prev.items));
  const merged = new Map();
  for (const it of fresh) {
    const old = prevItems.get(it.item_id), { reaction, ...rest } = it;
    merged.set(it.item_id, { ...rest, discovered_ts: old ? old.discovered_ts : now, backlog: old ? !!old.backlog : !hadPrev, first_seen_ts: old ? (old.first_seen_ts || old.discovered_ts) : now,
      discovery_lag_ms: old ? old.discovery_lag_ms : (!hadPrev || rest.published_ts === null ? null : now - rest.published_ts), reaction: [], in_current_feed: true });
  }
  for (const [id, old] of prevItems) if (!merged.has(id)) merged.set(id, { ...old, in_current_feed: false });                  // fell out of the live feed window: kept, labelled
  const items = [...merged.values()].sort((a, b) => (b.published_ts || b.discovered_ts) - (a.published_ts || a.discovered_ts)).slice(0, KEEP);
  const sources_ = ing.sourceHealth(), okAny = sources_.some(s => s.status === "OK");
  const counts = { total: items.length, relevant: items.length, hidden_not_relevant: 0, backlog: items.filter(i => i.backlog).length, by_scope: items.reduce((m, i) => (m[i.scope] = (m[i.scope] || 0) + 1, m), {}) };
  return { schema_version: SCHEMA, generated_ts: now, generated_utc: new Date(now).toISOString(), previous_generated_ts: hadPrev ? prev.generated_ts : null, any_source_ok: okAny,
    last_success_ts: okAny ? now : (prev && prev.last_success_ts) || null, sources: sources_, counts, items,
    note: "published snapshot of official feeds with rule-based interpretation: context only, not a trading signal. Not live: it changes only when the scheduled job publishes. No price reaction is available here." };
}
module.exports = { buildSnapshot, SCHEMA, KEEP };
