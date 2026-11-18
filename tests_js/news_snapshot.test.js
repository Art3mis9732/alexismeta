"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { buildSnapshot } = require("../server/news_snapshot"), { SOURCES } = require("../server/news");
const FX = p => fs.readFileSync(path.join(__dirname, "fixtures", "news", p), "utf8");
const BY = { fed_press_all: "fed_press_all.xml", sec_press: "sec_press.xml", fed_press_monetary: "fed_press_monetary.xml", fed_speeches: "fed_speeches.xml", bitget_announcements: "bitget_announcements.json", bitget_maintenance: "bitget_maintenance.json", okx_announcements: "okx_announcements.json" };
const fakeFetch = (fail = {}) => async (url) => { const src = SOURCES.find(s => s.url === url); if (!src || fail[src.id]) return { status: fail[src && src.id] || 500, headers: { get: () => null }, text: async () => "<title>Down</title>" };
  return { status: 200, headers: { get: () => null }, text: async () => FX(BY[src.id]) }; };
const T = Date.UTC(2026, 10, 17, 12), run = (o) => buildSnapshot({ now: T, spacingMs: 0, fetchImpl: fakeFetch(o.fail), prev: o.prev || null, ...o.extra });

test("snapshot: first run builds interpreted items from every source; all are backlog because discovery time is unknowable", async () => {
  const s = await run({}); assert.equal(s.schema_version, "news-snapshot-v1"); assert.ok(s.items.length > 10); assert.equal(s.any_source_ok, true); assert.equal(s.sources.length, SOURCES.length);
  assert.ok(s.items.every(i => i.backlog === true && i.reaction.length === 0 && i.discovered_ts === T), "no reaction, no invented discovery time");
  assert.ok(s.items.some(i => i.interpretations.length > 0)); assert.ok(s.items.every(i => /^https:\/\//.test(i.url) && i.publisher && i.title));
  assert.match(s.note, /Not live/); assert.ok(JSON.stringify(s).length < 600000);
});
test("snapshot: the previous snapshot is memory: known items keep their first-seen time, new items get this run's time, dropped items are kept and labelled", async () => {
  const a = await run({}), id0 = a.items[0].item_id, later = T + 6 * 3600000;
  const prev = { ...a, items: a.items.map(i => ({ ...i, backlog: false, discovered_ts: T - 9999 })).concat([{ ...a.items[0], item_id: "gone-item", discovered_ts: T - 5, backlog: false, title: "Fell out of the feed" }]) };
  const b = await buildSnapshot({ now: later, spacingMs: 0, fetchImpl: fakeFetch({}), prev });
  const kept = b.items.find(i => i.item_id === id0); assert.equal(kept.discovered_ts, T - 9999); assert.equal(kept.backlog, false); assert.equal(kept.in_current_feed, true);
  const gone = b.items.find(i => i.item_id === "gone-item"); assert.equal(gone.in_current_feed, false); assert.equal(b.previous_generated_ts, a.generated_ts);
  const prev2 = { ...a, items: a.items.slice(1) }, c = await buildSnapshot({ now: later, spacingMs: 0, fetchImpl: fakeFetch({}), prev: prev2 });
  const fresh = c.items.find(i => i.item_id === a.items[0].item_id); assert.equal(fresh.discovered_ts, later); assert.equal(fresh.backlog, false, "seen for the first time after a previous snapshot existed: genuinely new to the snapshot");
});
test("snapshot: one failing source is reported (status, error) and the rest still publish; all failing is detectable", async () => {
  const s = await run({ fail: { sec_press: 503, okx_announcements: 500 } }); const bad = s.sources.filter(x => x.status !== "OK").map(x => x.source).sort();
  assert.deepEqual(bad, ["okx_announcements", "sec_press"]); assert.equal(s.any_source_ok, true); assert.ok(s.items.length > 5);
  const all = await run({ fail: Object.fromEntries(SOURCES.map(x => [x.id, 503])) }); assert.equal(all.any_source_ok, false); assert.equal(all.items.length, 0);
  const kept = await buildSnapshot({ now: T + 1, spacingMs: 0, fetchImpl: fakeFetch(Object.fromEntries(SOURCES.map(x => [x.id, 503]))), prev: s }); assert.equal(kept.last_success_ts, s.last_success_ts); assert.equal(kept.items.length, s.items.length, "an outage never erases known items");
});
