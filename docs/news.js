/* News & market events tab (browser side). RENDER ONLY: items, source health, counts, interpretations and reactions all come
 * from the worker's /api/news (server/news.js, news_interpret.js, news_reaction.js). Nothing here classifies, interprets or
 * computes a price reaction. Interpretations are POTENTIAL directions from unevaluated keyword rules: they are not
 * probabilities, not trade signals, and never claim an item is "already priced in".
 * Uses globals from index.html/monitor.js: $, esc, istT, TZ, WMODE, WORKER_LOST, sym, view, apiJson. */
"use strict";
var NEWS = { data: null, error: null, loadedAt: 0, asset: "", source: "", all: false, started: false, cls: "", limit: 15 };
function nAttr(s) { return String(s).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); }
function nAge(ms) { if (ms === null || ms === undefined) return "n/a"; var m = Math.round(ms / 60000); return m < 1 ? "<1 min" : m < 90 ? m + " min" : m < 2880 ? (m / 60).toFixed(1) + " h" : (m / 1440).toFixed(1) + " d"; }
function nTime(ms) { return ms ? istT(ms) + " " + TZ.label : "unknown"; }

async function newsStart() {
  if (NEWS.started) return; NEWS.started = true;
  setInterval(function () { if (WMODE || (NEWS.mode === "snapshot" && Date.now() - NEWS.loadedAt > 240000)) newsLoad(); }, 30000);
  if (!WMODE) newsLoadStatic();
  ["nAsset", "nSource", "nAll", "nClass"].forEach(function (k) { $(k).onchange = function () { NEWS.asset = $("nAsset").value; NEWS.source = $("nSource").value; NEWS.all = $("nAll").checked; NEWS.cls = $("nClass").value; NEWS.limit = 15; newsLoad(); }; });
}
/** Public (static) site: no worker, so show the PUBLISHED SNAPSHOT (data/news.json, built by the scheduled job) with its age. Never presented as live; no price reaction exists in it. */
async function newsLoadStatic() {
  try {
    var r = await fetch("data/news.json?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json(); if (!j || j.schema_version !== "news-snapshot-v1" || !Array.isArray(j.items)) throw new Error("unrecognised snapshot");
    NEWS.snap = j; NEWS.snapErr = null; NEWS.mode = "snapshot"; NEWS.loadedAt = Date.now();
  } catch (e) { NEWS.snap = null; NEWS.snapErr = String(e.message || e); NEWS.mode = null; NEWS.data = null; }
  newsApplySnapshot(); newsRender();
}
/** apply the asset/source filters client-side and shift source ages forward by the time since the snapshot was generated */
function newsApplySnapshot() {
  var j = NEWS.snap; if (!j) { NEWS.data = null; return; }
  var delta = Math.max(0, Date.now() - j.generated_ts), items = j.items.filter(function (it) {
    return (!NEWS.asset || (it.interpretations || []).some(function (p) { return p.asset === NEWS.asset; })) && (!NEWS.source || it.source === NEWS.source); });
  NEWS.data = { schema_version: j.schema_version, as_of: j.generated_ts, note: j.note, items: items, counts: { total: j.items.length, relevant: items.length, hidden_not_relevant: 0, backlog: j.items.filter(function (i) { return i.backlog; }).length },
    coverage: "7 sources: Federal Reserve (3 feeds), SEC press releases, Bitget and OKX exchange announcements. Not comprehensive: no CFTC, ECB, BLS, ETF issuers, crypto media or security-incident feeds.",
    sources: j.sources.map(function (s) { return Object.assign({}, s, { fetch_age_ms: s.fetch_age_ms === null || s.fetch_age_ms === undefined ? null : s.fetch_age_ms + delta, newest_item_age_ms: s.newest_item_age_ms === null || s.newest_item_age_ms === undefined ? null : s.newest_item_age_ms + delta }); }) };
}
async function newsLoad() {
  if (!WMODE) { if (!NEWS.snap || Date.now() - NEWS.loadedAt > 240000) await newsLoadStatic(); else { newsApplySnapshot(); newsRender(); } return; }
  NEWS.mode = "worker";
  var q = "api/news?limit=80" + (NEWS.asset ? "&asset=" + NEWS.asset : "") + (NEWS.source ? "&source=" + encodeURIComponent(NEWS.source) : "") + (NEWS.all ? "&all=1" : "");
  try { NEWS.data = await apiJson(q); NEWS.error = null; NEWS.loadedAt = Date.now(); } catch (e) { NEWS.error = "The worker did not answer the news request."; }
  try { NEWS.shadow = await apiJson("api/news/shadow?limit=30"); } catch (e) { NEWS.shadow = null; }
  newsRender();
}
var N_VERDICT = { WOULD_BLOCK: ["■ WOULD BLOCK", "down"], WOULD_VETO: ["▼ WOULD VETO", "down"], CAUTION: ["▲ CAUTION", "warn"], SUPPORTS: ["● SUPPORTS (note only)", "up"], NEUTRAL: ["○ NEUTRAL", ""], NO_RELEVANT_NEWS: ["– no relevant news", ""] };
function newsShadowRender() {
  var el = $("nShadow"); if (!el) return; var S = NEWS.shadow;
  if (!WMODE && !S) { el.textContent = "Needs the local worker: candidate entries and what the news overlay would have said about them are recorded there."; return; }
  if (!S) { el.textContent = "The worker did not return shadow records (it may be running an older build)."; return; }
  var by = S.summary && S.summary.by_verdict || {}, head = Object.keys(by).map(function (k) { return k.replace(/_/g, " ").toLowerCase() + ": " + by[k].candidates; }).join(" · ") || "no candidate entries recorded yet";
  el.innerHTML = '<div><b>' + nAttr(S.mode) + "</b> · overlay " + nAttr(S.overlay_version) + " · effect on decisions: <b>" + nAttr(S.effect_on_decisions) + "</b>. " + nAttr(head) + ".</div>" +
    '<div class="sub">' + nAttr(S.summary ? S.summary.caveat : "") + "</div>" + (S.rows.length ? "<table><tr><th>Decision time</th><th>Analyst · coin</th><th>Candidate</th><th>News verdict</th><th>Why (observed, not causal)</th><th>Risk gate / paper result</th></tr>" + S.rows.map(function (r) {
      var v = N_VERDICT[r.verdict] || [r.verdict, ""], a = r.assessment || {}, res = r.pos_state === "CLOSED" ? "closed, net " + Number(r.pos_pnl).toFixed(2) + " USDT" : r.pos_state === "OPEN" ? "position open" : nAttr(r.risk_outcome || "no position");
      return "<tr><td>" + nAttr(nTime(r.decision_ts)) + "</td><td>" + nAttr(r.analyst.replace("_", " ")) + " · " + nAttr(r.instrument_id.split(":").pop()) + "</td><td>" + nAttr(r.intent.replace("OPEN_", "")) + '</td><td class="' + v[1] + '"><b>' + nAttr(v[0]) + "</b>" + (r.would_change ? " (would have changed the decision)" : "") + '</td><td class="sub">' + (a.reasons && a.reasons.length ? nAttr(a.reasons.join("; ")) : "no relevant article in this analyst's window") + "</td><td>" + res + "</td></tr>";
    }).join("") + "</table>" : "");
}
var N_STATUS = { OK: ["● OK", "up"], DEGRADED: ["◐ DEGRADED", "warn"], STALE: ["◐ STALE", "warn"], FAILING: ["○ FAILING", "down"], BACKOFF: ["○ BACKING OFF", "down"], RATE_LIMITED_BACKOFF: ["○ RATE-LIMITED, BACKING OFF", "down"], NOT_YET_POLLED: ["◐ NOT YET POLLED", "muted"] };
var N_STANCE = { BULLISH: ["▲ BULLISH (potential)", "up"], BEARISH: ["▼ BEARISH (potential)", "down"], NEUTRAL: ["◆ NEUTRAL (administrative)", "muted"], MIXED: ["◆ MIXED", "muted"], UNCERTAIN: ["◆ UNCERTAIN", "muted"] };

function newsRender() {
  if (!$("newsView")) return;
  newsShadowRender();
  var d = NEWS.data, snap = NEWS.mode === "snapshot" && !WMODE, frozen = !WMODE && d && !snap;
  if (!WMODE && !d) {
    $("nSummary").innerHTML = ""; $("nSources").innerHTML = "";
    $("nItems").innerHTML = '<b>No news available on this page.</b> The public site shows a published snapshot of the official feeds' + (NEWS.snapErr ? ' (it could not be loaded: ' + esc(NEWS.snapErr) + ")" : " (loading…)") + '. Live news needs the local worker (<code>npm start</code>, then open <b>http://127.0.0.1:8787</b>). Nothing is simulated here.';
    return;
  }
  if (!d) { $("nItems").textContent = NEWS.error || "Loading news from the worker…"; return; }
  var S = d.sources || [], C = d.counts || { total: 0, relevant: 0, hidden_not_relevant: 0 }, ok = S.filter(function (s) { return s.status === "OK"; }).length;
  var snapAge = snap ? Date.now() - NEWS.snap.generated_ts : 0;
  $("nSummary").innerHTML = (snap ? '<div class="banner" style="display:block;margin-bottom:6px;border-color:' + (snapAge > 6 * 3600000 ? "var(--warn)" : "var(--line)") + '"><b>PUBLISHED SNAPSHOT — not live.</b> Generated ' + nTime(NEWS.snap.generated_ts) + " (" + nAge(snapAge) + " ago) by the scheduled job from the official feeds" + (snapAge > 6 * 3600000 ? ' · <b class="warn">older than 6 hours: the publishing job may be delayed</b>' : "") +
      ". “Discovered” means first seen by a snapshot, not when the article appeared. No price reaction is available here: run the local worker (<code>npm start</code>) for live news with price reaction.</div>" : "") + (frozen ? '<span class="down"><b>○ WORKER DISCONNECTED</b></span> — showing the last news loaded at ' + nTime(NEWS.loadedAt) + "; nothing is updating. " : "") +
    "<b>" + ok + " of " + S.length + " sources healthy</b> · " + C.total + " items stored · <b>" + C.relevant + "</b> relate to BTC / ETH / XRP, macro policy or Bitget operations · " + C.hidden_not_relevant + " not related" + (C.backlog ? " · " + C.backlog + " from the first poll (backlog)" : "") +
    (C.hidden_not_relevant && !NEWS.all ? ' · <a href="#" id="nShowAll">show everything</a>' : "") + '. <span class="muted">as of ' + nTime(d.as_of) + "</span>";
  var sa = $("nShowAll"); if (sa) sa.onclick = function (e) { e.preventDefault(); NEWS.all = true; $("nAll").checked = true; newsLoad(); };
  var sel = $("nSource"), cur = NEWS.source; if (sel.options.length !== S.length + 1) { sel.innerHTML = '<option value="">all sources</option>' + S.map(function (s) { return '<option value="' + nAttr(s.source) + '">' + esc(s.source) + "</option>"; }).join(""); sel.value = cur; }
  $("nSources").innerHTML = '<table class="' + (frozen ? "frozen" : "") + '"><tr><th>Source</th><th>Category</th><th>Status</th><th class="r" title="Time since the last SUCCESSFUL fetch">Fetched</th><th>Cadence</th><th class="r" title="Age of the newest item the source has published. A quiet source can be healthy.">Newest item</th><th class="r" title="Median of (time we discovered it − time the source says it published it), items after the first poll only">Discovery lag</th><th>Notes</th></tr>' +
    S.map(function (s) { var st = N_STATUS[s.status] || [s.status, "muted"];
      return "<tr><td><b>" + esc(s.source) + '</b><br><span class="sub">' + esc(s.publisher) + " · " + esc(s.url_host) + "</span></td><td>" + esc(s.category.replace("_", " ")) + (s.verification === "INTERESTED_PARTY_CLAIM" ? '<br><span class="pill">interested party</span>' : '<br><span class="pill good">official primary</span>') + "</td>" +
        '<td><b class="' + st[1] + '">' + st[0] + "</b>" + (s.backoff_until ? '<br><span class="sub">next try after ' + nTime(s.backoff_until) + "</span>" : "") + '</td><td class="num">' + nAge(s.fetch_age_ms) + " ago</td><td class=\"sub\">" + esc(s.cadence) + '</td><td class="num">' + nAge(s.newest_item_age_ms) + '</td><td class="num">' + (s.median_discovery_lag_ms === null ? "n/a" : nAge(s.median_discovery_lag_ms)) +
        '</td><td class="sub">' + (s.last_error ? '<span class="warn">' + esc(s.last_error) + "</span> · " : "") + esc(s.items_stored + " items stored") + "</td></tr>"; }).join("") + "</table>" +
    '<div class="sub" style="margin-top:6px">' + esc(d.coverage) + " “Fetched” is source freshness; “Newest item” is article age: they are different clocks. These are polled feeds, not instant streams.</div>";
  // Source health is secondary to the articles, so it is collapsed; it opens itself (once per problem) when a source is not OK.
  var bad = S.filter(function (s) { return s.status !== "OK"; }), sig = bad.map(function (s) { return s.source + ":" + s.status; }).join(","), box = $("nSrcBox");
  $("nSrcSum").innerHTML = "<b>Source health</b> — " + (bad.length ? '<b class="warn">' + bad.length + " of " + S.length + " sources need attention: " + esc(bad.map(function (s) { return s.source + " " + (N_STATUS[s.status] || [s.status])[0]; }).join(", ")) + "</b>" : '<b class="up">all ' + S.length + " sources OK</b>") + " · freshness of retrieval, not age of articles · click to expand";
  if (bad.length && NEWS.badSig !== sig) box.open = true;
  NEWS.badSig = sig;
  var items = (d.items || []).filter(function (it) { return !NEWS.cls || newsClass(it).w.indexOf(NEWS.cls) === 0; });
  if (!items.length) { $("nItems").innerHTML = newsEmptyReason(d, S, C); return; }
  var rank = function (it) { return (it.backlog ? 2 : 0) + (it.scope === "ASSET" ? 0 : 1); };
  var sorted = items.slice().sort(function (a, b) { return rank(a) - rank(b) || (b.published_ts || b.discovered_ts) - (a.published_ts || a.discovered_ts); });
  var total = sorted.length, shown = sorted.slice(0, NEWS.limit);
  var fresh = shown.filter(function (i) { return !i.backlog; }), older = shown.filter(function (i) { return i.backlog; });
  var head = function (t, n, sub) { return '<h3 style="margin:14px 0 2px;font-size:14px">' + esc(t) + " <span class=\"muted\">(" + n + ")</span></h3><div class=\"sub\">" + esc(sub) + "</div>"; };
  $("nItems").innerHTML = '<div class="sub" style="margin-bottom:6px">' + esc(d.note) + "</div>" +
    (fresh.length ? head("New since monitoring began", fresh.length, "Discovered after the first poll of their source, so the discovery time is meaningful.") + fresh.map(newsItem).join("") : '<div class="sub" style="margin-top:8px"><b>No new items since monitoring began.</b> Quiet feeds are normal; the earlier items below were already published when monitoring started.</div>') +
    (older.length ? head("Earlier items (already published when monitoring started)", older.length, "Shown for context; their discovery time is when this system first looked, not when they appeared.") + older.map(newsItem).join("") : "") +
    (total > shown.length ? '<div style="margin-top:12px"><button id="nMore" class="seg" style="padding:6px 12px">Show ' + Math.min(15, total - shown.length) + " more (" + (total - shown.length) + " not shown of " + total + ")</button></div>" : '<div class="sub" style="margin-top:10px">All ' + total + " matching item(s) shown.</div>");
  var mb = $("nMore"); if (mb) mb.onclick = function () { NEWS.limit += 15; newsRender(); };
}
function newsEmptyReason(d, S, C) {
  var allBad = S.length && S.every(function (s) { return s.status !== "OK"; });
  if (allBad && C.total === 0) return "<b>No news stored and every source is failing or not yet polled.</b> See the source table above for the error of each.";
  if (C.total === 0) return "<b>No items stored yet.</b> Sources are polled every 5–15 minutes; the first poll may still be running.";
  if (!NEWS.all && C.relevant === 0) return "<b>" + C.total + " items are stored, but none relates to BTC, ETH, XRP, macro policy or Bitget operations.</b> The official sources mostly publish unrelated items. <a href=\"#\" id=\"nShowAll2\">Show everything</a>.";
  return "<b>Your filters exclude everything</b> (" + (NEWS.asset || "all assets") + " · " + (NEWS.source || "all sources") + " · " + (NEWS.cls ? NEWS.cls + " only" : "any classification") + (NEWS.all ? " · including unrelated" : " · relevant only") + "). Clear a filter to see items.";
}
function newsGroups(it) {
  var g = {};
  (it.interpretations || []).forEach(function (p) { var k = JSON.stringify([p.stance, p.kind, p.mechanism, p.rule_ids]); (g[k] = g[k] || { p: p, assets: [] }).assets.push(p.asset); });
  return Object.keys(g).map(function (k) { return g[k]; });
}
/** One plain-language classification for the card: colour AND words (never colour alone). Describes a possible implication, never an instruction. */
function newsClass(it) {
  var ps = it.interpretations || []; if (!ps.length) return { w: "NOT CLASSIFIED", sub: "not tied to BTC, ETH, XRP, macro policy or Bitget operations", c: "muted", b: "var(--line)", sq: "□" };
  var st = {}; ps.forEach(function (p) { st[p.stance] = 1; });
  if (ps.some(function (p) { return p.kind === "operational_risk"; })) return { w: "UNCERTAIN · OPERATIONAL RISK", sub: "venue operations notice: execution and data quality, not a price direction", c: "warn", b: "var(--warn)", sq: "◇" };
  if (st.BULLISH && !st.BEARISH && !st.MIXED) return { w: "GREEN · POTENTIALLY BULLISH", sub: "a possible implication, not a buy instruction", c: "up", b: "var(--up)", sq: "■" };
  if (st.BEARISH && !st.BULLISH && !st.MIXED) return { w: "RED · POTENTIALLY BEARISH", sub: "a possible implication, not a sell instruction", c: "down", b: "var(--down)", sq: "■" };
  if (st.MIXED || (st.BULLISH && st.BEARISH)) return { w: "GRAY · MIXED", sub: "both supportive and adverse wording", c: "muted", b: "var(--muted)", sq: "■" };
  if (st.NEUTRAL && !st.UNCERTAIN) return { w: "GRAY · NEUTRAL", sub: "administrative or no policy content found by the rule", c: "muted", b: "var(--muted)", sq: "■" };
  return { w: "UNCERTAIN · INSUFFICIENT EVIDENCE", sub: "direction depends on a surprise this system cannot measure", c: "muted", b: "var(--line)", sq: "◇" };
}
function newsItem(it) {
  var rev = it.reaction || [], tz = TZ.label, cl = newsClass(it), coins = (it.interpretations || []).map(function (p) { return p.asset; }).filter(function (a, i, arr) { return arr.indexOf(a) === i; });
  var interp = it.interpretation_status === "AVAILABLE" ? newsGroups(it).map(function (g) { var p = g.p, st = N_STANCE[p.stance] || [p.stance, "muted"];
    return '<div style="margin-top:6px"><b>' + esc(g.assets.join(" · ")) + ':</b> <b class="' + st[1] + '">' + st[0] + '</b> <span class="pill">' + esc(p.kind.replace("_", " ")) + "</span>" + (p.mechanism ? '<div class="sub">Mechanism: ' + esc(p.mechanism) + (p.horizon ? " Horizon: " + esc(p.horizon) + "." : "") + "</div>" : "") +
      "<details><summary>Evidence and limits</summary><div class=\"sub\">" + (p.supporting.length ? "<b>Supporting:</b> " + esc(p.supporting.join(" ")) + "<br>" : "") + (p.contradicting.length ? "<b>Contradicting / caveats:</b> " + esc(p.contradicting.join(" ")) + "<br>" : "") + "<b>Limitations:</b> " + esc(p.limitations.join(" ")) +
      "<br>Method: " + esc(p.interpreter) + " (" + esc(p.rule_ids.join(", ")) + ") — headline-level keyword rule, not evaluated against prices. No probability or confidence is attached.</div></details></div>"; }).join("")
    : '<div class="sub" style="margin-top:6px">' + (it.interpretation_status === "NOT_APPLICABLE" ? "No interpretation: not tied to BTC, ETH, XRP, macro policy or Bitget operations." : "<b>Interpretation unavailable</b> for this item (the interpreter failed or has not run). The article is shown as published.") + "</div>";
  var allNA = rev.length && rev.every(function (r) { return r.horizons.every(function (h) { return h.status === "NA"; }); });
  var reac = !rev.length ? "" : allNA ? '<div class="sub" style="margin-top:6px"><b>Observed price reaction since discovery:</b> N/A — ' + esc(rev[0].horizons[0].reason) + "</div>"
    : '<div class="sub" style="margin-top:6px"><b>Observed price reaction since discovery</b> (Bitget perpetual, association not cause; “already priced in” is not assessed):<table>' + rev.map(function (r) {
      return "<tr><td>" + esc(r.asset) + "</td>" + r.horizons.map(function (h) { return '<td class="num" title="' + nAttr(h.reason || "") + '">+' + esc(h.horizon) + " " + (h.status === "OK" ? '<b class="' + (h.pct > 0 ? "up" : h.pct < 0 ? "down" : "muted") + '">' + (h.pct > 0 ? "+" : h.pct < 0 ? "−" : "") + Math.abs(h.pct).toFixed(3) + "%</b>" : h.status === "PENDING" ? '<span class="muted">pending</span>' : '<span class="muted">N/A</span>') + "</td>"; }).join("") + "</tr>"; }).join("") + "</table></div>";
  var refs = (it.refs || []).filter(function (r) { return r.source !== it.source; }).map(function (r) { return r.source; });
  return '<div class="pf newsitem" data-item="' + nAttr(it.item_id || "") + '" data-class="' + nAttr(cl.w.split(" ")[0]) + '" style="cursor:default;margin-top:10px;border-left:4px solid ' + cl.b + '"><div class="sub"><b class="' + cl.c + '">' + cl.sq + " " + esc(cl.w) + "</b> · " + esc(cl.sub) + (coins.length ? " · coins: <b>" + esc(coins.join(" · ")) + "</b>" : "") + '</div><div><a href="' + nAttr(it.url) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(it.title) + "</b></a>" + (it.revisions_known ? ' <span class="pill">revised ×' + it.revisions_known + "</span>" : "") + "</div>" +
    '<div class="sub">' + esc(it.publisher) + " · " + esc(it.source_category.replace("_", " ")) + (it.verification === "INTERESTED_PARTY_CLAIM" ? ' · <span class="pill">interested-party claim</span>' : ' · <span class="pill good">official primary</span>') + " · " + esc(it.event_type.replace(/_/g, " ")) + " · scope " + esc(it.scope.replace("_", " ")) + "</div>" +
    '<div class="sub">Published ' + (it.ts_certainty === "UNKNOWN" ? "<b>time unknown</b> (ordered by discovery)" : nTime(it.published_ts)) + " · discovered " + nTime(it.discovered_ts) + " · " + (it.backlog ? '<span class="pill" title="Found in this source\'s first poll: the discovery time is when the worker started, not when the item appeared">backlog</span>' : "discovery lag " + nAge(it.discovery_lag_ms)) +
    (refs.length ? " · also carried by " + esc(refs.join(", ")) : "") + (it.cluster_size > 1 ? " · " + it.cluster_size + " similar headlines (one event, not independent confirmation)" : "") + "</div>" +
    (it.summary ? '<div class="sub">' + esc(it.summary) + "</div>" : "") + interp + reac + "</div>";
}
document.addEventListener("click", function (e) { if (e.target && e.target.id === "nShowAll2") { e.preventDefault(); NEWS.all = true; $("nAll").checked = true; newsLoad(); } });
