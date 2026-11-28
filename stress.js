/* Market stress (browser side). RENDER ONLY: severity, data quality, levels, trend, gate verdicts, events and news context all come from
 * the worker's /api/stress (server/stress.js, stress_monitor.js). Nothing here measures, classifies or decides.
 * Three things are kept apart on screen: OBSERVED (measurements from the market feed), POSSIBLE EXPLANATION (news that coincides in time,
 * rule-interpreted and unevaluated), UNVERIFIED HYPOTHESES (what the data cannot establish). Thresholds are PROVISIONAL.
 * Uses globals from index.html/monitor.js/news.js: $, esc, istT, TZ, WMODE, WORKER_LOST, apiJson, nAttr. */
"use strict";
var STRESS = { data: null, error: null, loadedAt: 0, started: false };
var SV = { NORMAL: ["● NORMAL", "up"], ELEVATED: ["▲ ELEVATED", "warn"], HIGH_STRESS: ["◆ HIGH STRESS", "down"], CRITICAL: ["■ CRITICAL", "down crit"] };
function sTime(ms) { return ms ? istT(ms) + " " + TZ.label : "unknown"; }
function sDur(ms) { if (ms === null || ms === undefined) return "n/a"; var s = Math.round(ms / 1000); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : (s / 3600).toFixed(1) + " h"; }
function sNum(v, d) { return v === null || v === undefined ? "—" : Number(v).toFixed(d === undefined ? 2 : d); }
function sLevel(l) { return l === null || l === undefined ? '<span class="muted">unavailable</span>' : ["<span class=\"up\">below ELEVATED</span>", "<span class=\"warn\">ELEVATED</span>", "<span class=\"down\">HIGH</span>", "<b class=\"down\">CRITICAL</b>"][l]; }

/* Headline state of one instrument, as text first (never colour only). */
function sHead(i) {
  if (i.quality === "UNRELIABLE") return { txt: "○ DATA UNRELIABLE", cls: "muted", sub: i.last_valid && i.last_valid.ts ? "last valid: " + (SV[i.last_valid.severity] ? SV[i.last_valid.severity][0].slice(2) : i.last_valid.severity) + " at " + sTime(i.last_valid.ts) : "no valid measurement yet" };
  if (!i.severity_known || i.severity === null) return { txt: "○ UNKNOWN", cls: "muted", sub: "no valid measurement yet" };
  var v = SV[i.severity]; return { txt: v[0], cls: v[1], sub: i.quality === "DEGRADED" ? "usable data, some inputs incomplete (see notes)" : "all inputs current" };
}

async function stressStart() {
  if (STRESS.started) return; STRESS.started = true;
  setInterval(function () { if (WMODE) stressLoad(); }, 5000);
}
async function stressLoad() {
  if (!WMODE) { stressRender(); return; }
  try { STRESS.data = await apiJson("api/stress"); STRESS.error = null; STRESS.loadedAt = Date.now(); } catch (e) { STRESS.error = "The worker did not answer the stress request."; }
  stressRender();
}

/* ---------------------------------------------------------------- summary strip (every tab) */
function stressBarRender() {
  var el = $("stressBar"); if (!el) return;
  var d = STRESS.data, frozen = !WMODE && d;
  if (!d) { el.innerHTML = '<b>MARKET STRESS</b> <span class="muted">' + (WMODE ? "loading…" : "needs the local worker (npm start): this page has no stress monitor and shows nothing simulated") + "</span>"; el.className = "stressbar"; return; }
  if (d.unavailable) { el.innerHTML = '<b>MARKET STRESS</b> <span class="warn">○ ' + esc(d.unavailable) + "</span>"; return; }
  var stale = d.monitor_age_ms !== null && d.monitor_age_ms > 30000;
  var chips = d.instruments.map(function (i) {
    var h = sHead(i), ev = i.event ? " · event " + sDur(i.event.duration_ms) : "";
    return '<a href="#" class="schip ' + h.cls.split(" ")[0] + '" data-stress-open="1" title="' + nAttr(h.sub) + '"><b>' + esc(i.symbol) + "</b> " + '<span class="' + h.cls + '">' + h.txt + "</span>" + esc(ev) + "</a>";
  }).join("");
  var syn = d.config.origin === "SYNTHETIC_FIXTURE" ? ' <span class="pill bad">SYNTHETIC TEST SCENARIO</span>' : "";
  el.className = "stressbar" + (d.instruments.some(function (i) { return i.severity === "CRITICAL" || i.severity === "HIGH_STRESS"; }) ? " hot" : "");
  el.innerHTML = '<b>MARKET STRESS</b> ' + chips + syn + (d.market_wide ? ' <span class="pill bad">MARKET-WIDE</span>' : "") +
    ' <span class="sub">policy ' + esc(d.config.mode) + (d.config.mode === "SHADOW" ? " (records what it would block; blocks nothing)" : " (blocks NEW paper entries)") + " · thresholds " + esc(d.config.calibration.status) +
    (frozen || WORKER_LOST ? ' · <b class="down">WORKER DISCONNECTED: not updating, last data ' + sTime(STRESS.loadedAt) + "</b>" : stale ? ' · <b class="down">monitor silent for ' + sDur(d.monitor_age_ms) + "</b>" : "") + "</span>";
  Array.prototype.forEach.call(el.querySelectorAll("[data-stress-open]"), function (a) { a.onclick = function (e) { e.preventDefault(); var t = document.querySelector('#views span[data-view="stress"]'); if (t) t.click(); }; });
}

/* ---------------------------------------------------------------- detail tab */
function metricRow(label, unit, value, th, level, note, lowWorse) {
  var t = th ? th.map(function (x) { return (lowWorse ? "≤ " : "≥ ") + x; }).join(" / ") : "—";
  return "<tr><td>" + esc(label) + '<br><span class="sub">' + esc(unit) + (note ? " · " + esc(note) : "") + '</span></td><td class="num"><b>' + sNum(value) + "</b></td><td class=\"num sub\">" + t + "</td><td>" + sLevel(level) + "</td></tr>";
}
function instCard(i, cfg) {
  var h = sHead(i), m = i.measures || {}, L = i.levels || {}, T = cfg.thresholds, g = i.gate || {};
  var mv = m.P_ret !== null && m.P_ret !== undefined ? (m.P_ret * 100 >= 0 ? "+" : "") + (m.P_ret * 100).toFixed(2) + "% over " + m.P_h + " min" : "";
  var rows = metricRow("Largest move vs normal noise", "robust z: |move| ÷ (σ1m·√minutes), max over 1, 5, 15 min", m.P, T.P, L.P, mv) +
    metricRow("Realised volatility vs normal", "× its 24 h median (last 15 min)", m.V, T.V, L.V, "") +
    metricRow("Volume vs normal", "robust z of 5-min volume (log) · confirms price only, never raises severity alone", m.A, T.A, L.A, "") +
    metricRow("Spread vs normal", "× baseline median (floor " + cfg.liquidity.spreadFloorBps + " bps) · PROVISIONAL, no historical depth", m.S, T.S, L.S, m.spread_bps !== null && m.spread_bps !== undefined ? sNum(m.spread_bps, 2) + " bps now" : "") +
    metricRow("Visible depth ±10 bps vs normal", "× baseline median, LOWER is worse · PROVISIONAL", m.D, T.D, L.D, m.depth_min ? Math.round(m.depth_min).toLocaleString() + " USDT min side" : "", true);
  var c = i.context || {};
  var ctx = '<div class="sub">Context only, never used for severity (no validated threshold): open interest ' + (c.open_interest === null || c.open_interest === undefined ? "n/a" : Number(c.open_interest).toLocaleString() + " (base coin)") +
    " · funding rate " + (c.funding_rate === null || c.funding_rate === undefined ? "n/a" : (c.funding_rate * 100).toFixed(4) + "% (interval not stated by the feed)") + " · book imbalance ±10 bps " + sNum(c.imbalance, 2) + " (spoofable)</div>";
  var verdict = g.would_block ? (g.enforced ? '<b class="down">NEW paper entries BLOCKED</b>' : '<b class="warn">would block new entries (SHADOW: nothing is blocked)</b>') : '<span class="up">new entries allowed</span>';
  var gline = verdict + " · " + esc(g.code ? g.code + " (" + g.scope + "): " + g.detail : g.detail || "") + ' · policy ' + esc(g.policy);
  var adv = ["Risk Taker", "Balanced Trader", "Defensive Trader"].map(function (n) { return "<li>" + n + ": " + (g.would_block ? (g.enforced ? "cannot open new positions in " + esc(i.symbol) : "would not be allowed to open new positions in " + esc(i.symbol) + " (shadow)") : "unrestricted by stress") + "</li>"; }).join("");
  var ev = i.event ? "<div><b>Event</b> " + esc(i.event.event_id) + " · onset " + sTime(i.event.onset_ts) + " · running " + sDur(i.event.duration_ms) + " · peak " + esc(i.event.peak) + "</div>" : "<div class=\"muted\">No active event.</div>";
  var trend = i.trend ? '<span class="pill ' + (i.trend.state === "WORSENING" ? "bad" : i.trend.state === "IMPROVING" ? "good" : "unknown") + '" title="' + nAttr(i.trend.basis) + '">' + esc(i.trend.state) + "</span>" : "";
  var why = (i.reasons || []).length ? '<details><summary>Data quality and warm-up notes (' + i.reasons.length + ")</summary><ul>" + i.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></details>" : "";
  var nc = i.news_context || { items: [] };
  var news = nc.items.length ? "<ul>" + nc.items.map(function (n) {
    return '<li><a href="' + nAttr(n.url) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + "</a> <span class=\"sub\">" + esc(n.publisher || n.source) + " · published " + sTime(n.published_ts) + " · discovered " + sTime(n.discovered_ts) + (n.stance ? " · rule-based reading: " + esc(n.stance) : "") + "</span></li>"; }).join("") + "</ul>"
    : '<div class="muted">No relevant news item was discovered in the window (' + esc(nc.window || "last 6 hours") + ").</div>";
  return '<div class="card scard"><h3 style="margin:0">' + esc(i.symbol) + ' <span class="' + h.cls + '" style="font-size:20px">' + h.txt + "</span> " + trend + '</h3><div class="sub">' + esc(h.sub) + " · data quality <b>" + esc(i.quality) + "</b>" +
    (i.since_ts ? " · in this state since " + sTime(i.since_ts) : "") + " · last evaluation " + sTime(i.last_eval_ts) + "</div>" + ev +
    (i.unobserved_since_ts ? '<div class="warn">Monitor was not running since ' + sTime(i.unobserved_since_ts) + ": any earlier event was closed as UNOBSERVED, not as recovered.</div>" : "") +
    '<div class="scols"><div><h4>Observed (measured from the market feed)</h4>' + (i.quality === "UNRELIABLE" ? '<div class="warn"><b>Data unreliable:</b> the figures below are the latest computed values and may be stale or incomplete. Severity above is the last VALID reading, retained, not a current one.</div>' : "") + '<table><tr><th>Measurement</th><th class="r">Now</th><th class="r">ELEVATED / HIGH / CRITICAL</th><th>Level</th></tr>' + rows + "</table>" +
    '<div class="sub">Rule applied: ' + esc(i.rule || "none yet") + "</div>" + ctx + why + '</div><div>' +
    '<h4>Risk-engine response</h4><div>' + gline + "</div><ul>" + adv + '</ul><div class="sub">Stress can only block NEW entries. Open positions keep their stops, targets and accounting.</div>' +
    '<h4>Possible explanation (news that coincides in time)</h4><div class="sub">' + esc(nc.note || "") + "</div>" + news +
    '<h4>Unverified hypotheses</h4><div class="sub">None is asserted. Large-holder selling, liquidation cascades and manipulation cannot be established from the data this system holds (no liquidation feed, no holder data, aggressor side unverified), so none is claimed.</div></div></div></div>';
}
function eventsTable(d) {
  var ev = d.events || []; if (!ev.length) return '<div class="muted">No stress event has been recorded in this database' + (d.config.origin === "SYNTHETIC_FIXTURE" ? " (synthetic scenario rows only)" : "") + ".</div>";
  return '<table><tr><th>Event</th><th>Onset</th><th>Confirmed</th><th class="r">Duration</th><th>Peak</th><th>Ended</th><th>Config</th></tr>' + ev.map(function (e) {
    var dur = e.end_ts ? sDur(e.end_ts - (e.onset_ts || e.confirmed_ts)) : "running";
    var tr = e.transitions.map(function (t) { return esc(sTime(t.ts)) + " " + esc(t.kind) + " " + esc((t.from || "") + (t.to && t.to !== t.from ? " → " + t.to : "")); }).join("<br>");
    return "<tr><td>" + esc(e.event_id) + "<br><details><summary>transitions</summary><span class=\"sub\">" + tr + "</span></details></td><td>" + sTime(e.onset_ts) + "</td><td>" + sTime(e.confirmed_ts) + '</td><td class="num">' + dur + "</td><td>" + esc(e.peak) + "</td><td>" +
      (e.end_ts ? sTime(e.end_ts) + "<br><span class=\"sub\">" + esc(e.end_reason) + (e.end_reason === "UNOBSERVED" ? " (not a recovery)" : "") + "</span>" : '<b class="warn">active</b>') + '</td><td class="sub">' + esc(e.config_version) + " · " + esc(e.calibration) + (e.origin === "SYNTHETIC_FIXTURE" ? " · SYNTHETIC" : "") + "</td></tr>"; }).join("") + "</table>";
}
function stressRender() {
  stressBarRender();
  if (!$("stressView")) return;
  var d = STRESS.data, frozen = !WMODE && d;
  if (!d) { $("sHead").innerHTML = ""; $("sInst").innerHTML = ""; $("sEvents").innerHTML = ""; $("sPolicy").innerHTML = "";
    $("sInst").innerHTML = WMODE ? "Loading…" : "<b>No local worker on this page.</b> Market stress is measured by the local worker from its own live feed and history (<code>npm start</code>, then open <b>http://127.0.0.1:8787</b>). Nothing is simulated here."; return; }
  if (d.unavailable) { $("sInst").innerHTML = esc(d.unavailable); return; }
  var c = d.config;
  $("sHead").innerHTML = (frozen || WORKER_LOST ? '<span class="down"><b>○ WORKER DISCONNECTED</b></span> — showing the last stress data loaded at ' + sTime(STRESS.loadedAt) + "; nothing is updating. " : "") +
    (c.origin === "SYNTHETIC_FIXTURE" ? '<span class="pill bad">SYNTHETIC TEST SCENARIO</span> scripted BTC crash for browser verification; ETH and XRP are real. Not a market measurement. ' : "") +
    "Detector <b>" + esc(c.version) + "</b> · thresholds <b>" + esc(c.calibration.status) + "</b> · policy mode <b>" + esc(c.mode) + "</b> since " + sTime(c.mode_effective_ts) + " · evaluated every " + (c.eval_ms / 1000) + " s · last evaluation " + sTime(d.last_tick_ts) +
    '<div class="sub" style="margin-top:4px">' + esc(c.calibration.note) + "</div>";
  $("sInst").innerHTML = d.instruments.map(function (i) { return instCard(i, c); }).join("");
  $("sEvents").innerHTML = eventsTable(d);
  var p = d.policy;
  $("sPolicy").innerHTML = '<div class="sub">' + esc(p.summary) + '</div><table><tr><th>State</th><th>Scope</th><th>New entries</th><th>Exposure</th><th>Open positions</th><th>Recovery</th></tr>' + p.table.map(function (r) {
    return "<tr><td><b>" + esc(r.state) + "</b></td><td>" + esc(r.scope) + "</td><td>" + esc(r.new_entries) + "</td><td>" + esc(r.exposure) + "</td><td>" + esc(r.existing_positions) + "</td><td>" + esc(r.recovery) + "</td></tr>"; }).join("") + "</table>" +
    '<div class="sub">Not implemented in v1: ' + p.not_implemented.map(esc).join("; ") + ".</div><div class=\"sub\">Calibration basis: " + esc(c.calibration.basis) + ". " + esc(c.calibration.evaluation || "") + "</div>";
}
