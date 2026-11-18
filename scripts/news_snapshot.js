#!/usr/bin/env node
"use strict";
/* node scripts/news_snapshot.js [docs/data/news.json]  — fetch the official feeds once and write the static news snapshot (carrying the previous file over as memory). */
const fs = require("node:fs"), path = require("node:path"), { buildSnapshot } = require("../server/news_snapshot");
(async () => {
  const out = process.argv[2] || path.join(__dirname, "..", "docs", "data", "news.json");
  let prev = null; try { prev = JSON.parse(fs.readFileSync(out, "utf8")); if (prev.schema_version !== "news-snapshot-v1") prev = null; } catch (e) { /* first run */ }
  const snap = await buildSnapshot({ prev, now: Date.now(), log: m => console.error(m) });
  if (!snap.any_source_ok && prev) { console.error("no source answered: keeping the previous snapshot unchanged"); process.exit(0); }
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(snap));
  console.log(JSON.stringify({ wrote: out, items: snap.items.length, sources_ok: snap.sources.filter(s => s.status === "OK").length + "/" + snap.sources.length, backlog: snap.counts.backlog }));
})();
