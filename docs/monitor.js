/* Live paper-trading monitor (browser side). RENDER ONLY.
 * Every number shown here was computed by the local worker (server/monitor.js + server/accounting.js) and arrives as a
 * REST snapshot plus a server-sent-event stream. This file never computes P&L, never opens or closes anything and has no
 * write access: the worker's API is GET-only. When the worker is unreachable the last backend values are FROZEN and
 * labelled with their age; the browser's own price feed is never used to revalue positions or accounts.
 * Uses globals from index.html: $, esc, nf, istT, istHMS, TZ, sym, view, WMODE, apiJson, LightweightCharts. */
"use strict";
var MON = { snap: null, val: null, runtime: null, cursor: 0, es: null, conn: "NOT_CONNECTED", lastFrame: 0, events: [], lat: [], detailId: null, detail: null, chart: null,
  diag: null, closed: [], registry: null, jobs: null, resnapshots: 0, dupes: 0, lost: false, started: false };
var M_AN = { risk_taker: "Risk Taker", balanced: "Balanced Trader", defensive: "Defensive Trader" };
function mNum(x, d) { return x === null || x === undefined || !isFinite(x) ? "N/A" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function mSigned(x, d) { return x === null || x === undefined || !isFinite(x) ? "N/A" : (x > 0 ? "+" : x < 0 ? "−" : "") + mNum(Math.abs(x), d); }
function mCls(x) { return x > 0 ? "up" : x < 0 ? "down" : "muted"; }
function mDp(p) { return p >= 1000 ? 1 : p >= 10 ? 2 : 4; }
function mDur(ms) { var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + "h " + m + "m" : m ? m + "m " + (s % 60) + "s" : s + "s"; }
function mAge(ms) { return ms === null || ms === undefined ? "N/A" : ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s"; }
function mShort(id) { var s = String(id || ""); return s.length > 14 ? "…" + s.slice(-13) : s; }

async function monitorStart() {
  if (MON.started) return monitorResnapshot("worker recovered");
  MON.started = true;
  setInterval(monitorTick, 1000);
  await monitorResnapshot("initial load");
  monitorSlow(); setInterval(monitorSlow, 15000);
}
/** Full reload from the backend, then stream only what comes after the snapshot's cursor. */
async function monitorResnapshot(why) {
  try {
    var r = await Promise.all([apiJson("api/runtime"), apiJson("api/paper/snapshot")]);
    MON.runtime = r[0]; MON.snap = r[1]; MON.val = r[1]; MON.cursor = r[1].cursor; MON.events = r[1].recent_activity.slice(); MON.closed = r[1].recent_closed;
    MON.lastFrame = Date.now(); MON.lost = false; MON.resnapshots++; MON.lastResnapshot = why;
    monitorOpenStream(); renderMonitor(true);
    if (MON.detailId) monitorOpenDetail(MON.detailId);
  } catch (e) { MON.conn = "DISCONNECTED"; renderMonitor(true); }
}
function monitorOpenStream() {
  if (MON.es) { MON.es.close(); MON.es = null; }
  if (typeof EventSource === "undefined") { MON.conn = "POLLING"; return; }            // fallback: monitorTick polls the snapshot
  var es = new EventSource("api/stream?after=" + MON.cursor); MON.es = es; MON.conn = "CONNECTING";
  es.addEventListener("hello", function (e) { var h = JSON.parse(e.data); MON.conn = "STREAMING"; MON.lastFrame = Date.now(); MON.dirty = true;
    if (MON.snap && (h.db_id !== MON.snap.db_id || h.instance_id !== MON.snap.instance_id)) monitorResnapshot("worker instance or database changed"); });
  es.addEventListener("activity", function (e) {
    var ev = JSON.parse(e.data); MON.lastFrame = Date.now();
    if (ev.seq <= MON.cursor) { MON.dupes++; return; }                                 // duplicate after a reconnect: ignore
    if (ev.prev !== MON.cursor) return monitorResnapshot("gap in the event sequence");  // missed something: reload, never guess
    MON.cursor = ev.seq; MON.events.unshift(ev); if (MON.events.length > 400) MON.events.length = 400;
    MON.lat.push(Date.now() - ev.recorded_ts); if (MON.lat.length > 50) MON.lat.shift();
    if (ev.type === "POSITION_CLOSED" || ev.type === "FILL") monitorSlow();
    renderMonitorActivity();
  });
  es.addEventListener("valuation", function (e) { MON.val = JSON.parse(e.data); MON.lastFrame = Date.now(); MON.conn = "STREAMING"; MON.lost = false; MON.dirty = true; });
  es.addEventListener("resnapshot", function () { monitorResnapshot("server asked for a resnapshot"); });
  es.onerror = function () { MON.conn = es.readyState === 2 ? "DISCONNECTED" : "RECONNECTING"; };
}
/** Once a second: staleness check, polling fallback, throttled repaint (rendering is independent of event arrival). */
function monitorTick() {
  if (!MON.started) return;
  var age = Date.now() - MON.lastFrame;
  if (MON.snap && age > 5000 && !MON.lost) { MON.lost = true; MON.dirty = true; }
  if (MON.conn === "POLLING" && WMODE && age > 2000) apiJson("api/paper/snapshot").then(function (s) { MON.val = s; MON.lastFrame = Date.now(); MON.lost = false; MON.dirty = true; }).catch(function () {});
  if (MON.lost && WMODE === false && MON.es && MON.es.readyState === 2) MON.conn = "DISCONNECTED";
  if (view !== "monitor") return;
  if (MON.dirty || MON.lost) { MON.dirty = false; renderMonitor(false); }
  else if (MON.snap) renderMonitorStatus();                  // ages and connection state repaint every second regardless of frames
}
function monitorLost() { MON.lost = true; MON.conn = "DISCONNECTED"; if (view === "monitor") renderMonitor(false); }
async function monitorSlow() {
  if (!WMODE) return;
  try { var r = await Promise.all([apiJson("api/paper/diagnostics"), apiJson("api/paper/closed?limit=50"), MON.registry ? null : apiJson("api/registry"), MON.jobs ? null : apiJson("api/jobs")]);
    MON.diag = r[0]; MON.closed = r[1].closed; if (r[2]) MON.registry = r[2]; if (r[3]) MON.jobs = r[3];
    if (view === "monitor") { renderMonitorDiag(); renderMonitorClosed(); renderMonitorRegistry(); }
  } catch (e) { /* status chips report connection problems */ }
}

// ------------------------------------------------------------------ rendering
function renderMonitor(full) {
  if (typeof $ !== "function" || !$("monitorView")) return;
  if (!MON.snap) {
    $("mStatus").innerHTML = mChip("Paper engine", "bad", "○ NOT AVAILABLE", "This page is not served by the local worker.");
    $("mAccounts").innerHTML = "The paper monitor shows the worker's ledger. Start the worker (<code>npm start</code>) and open <b>http://127.0.0.1:8787</b>. A public static page has no worker, so there is nothing to show here, and nothing is simulated in its place.";
    ["mPositions", "mDiag", "mActivity", "mClosed", "mRegistry", "mBuild", "mTest"].forEach(function (k) { $(k).innerHTML = ""; });
    return;
  }
  var v = MON.val || MON.snap, test = v.environment !== "FORWARD";
  $("mTest").innerHTML = test ? '<div class="testbar" role="alert">TEST ENVIRONMENT — synthetic fixture triggers on live prices, separate database and ledger. Engineering verification only. NOT forward evidence.</div>' : "";
  renderMonitorStatus(); renderMonitorAccounts(); renderMonitorPositions();
  if (full) { renderMonitorActivity(); renderMonitorDiag(); renderMonitorClosed(); renderMonitorRegistry(); }
}
function mChip(title, cls, state, detail) { return '<div class="chip ' + cls + '"><b>' + esc(title) + "</b>" + esc(state) + '<div class="sub">' + esc(detail || "") + "</div></div>"; }
function renderMonitorStatus() {
  var v = MON.val || MON.snap, e = v.engine || {}, f = v.feeds || null, age = Date.now() - MON.lastFrame, lost = MON.lost;
  var lat = MON.lat.length ? MON.lat.slice().sort(function (a, b) { return a - b; })[Math.floor(MON.lat.length / 2)] : null;
  var pos = v.positions || [], stale = pos.some(function (p) { return p.valuation && p.valuation.mark.status !== "OK"; });
  var chips = [];
  chips.push(lost ? mChip("Market feed (worker)", "bad", "○ UNKNOWN", "no backend status for " + mAge(age))
    : f ? mChip("Market feed (worker)", f.healthy === f.total && f.socket === "open" ? "ok" : "warnc", (f.healthy === f.total && f.socket === "open" ? "● HEALTHY " : "◐ DEGRADED ") + f.healthy + "/" + f.total, f.not_healthy && f.not_healthy.length ? f.not_healthy.join("; ") : "Bitget public stream, socket " + f.socket)
    : mChip("Market feed (worker)", "warnc", "◐ WAITING", "first stream frame not received yet"));
  var nb = e.next_bar_close_ts ? Math.max(0, Math.round((e.next_bar_close_ts - (v.calc_ts + (lost ? 0 : 0))) / 1000)) : null;
  chips.push(lost ? mChip("Decision engine", "bad", "○ DISCONNECTED", "not known to be running") : mChip("Decision engine", e.state === "RUNNING" ? "ok" : "bad", (e.state === "RUNNING" ? "● " : "○ ") + (e.state || "UNKNOWN"),
    (e.last_bar_close_ts ? "last decision for bar " + istT(e.last_bar_close_ts) + " " + TZ.label + " (+" + mAge(e.last_decision_lag_ms) + ")" : "no bar decided since this worker started") + (nb !== null ? " · next bar close in ~" + Math.floor(nb / 60) + "m " + (nb % 60) + "s" : "")));
  chips.push(lost ? mChip("Paper engine", "bad", "○ DISCONNECTED", "positions are NOT being managed as far as this page can tell") : mChip("Paper engine", e.state === "RUNNING" ? "ok" : "bad", (e.state === "RUNNING" ? "● " : "○ ") + (e.state || "UNKNOWN"), e.detail || ("tick " + mAge(e.last_tick_age_ms) + " ago · PAPER only")));
  chips.push(mChip("Browser connection", lost ? "bad" : MON.conn === "STREAMING" ? "ok" : "warnc", (lost ? "○ " : MON.conn === "STREAMING" ? "● " : "◐ ") + (lost ? "DISCONNECTED" : MON.conn),
    "last backend frame " + mAge(age) + " ago" + (lat !== null ? " · event latency median " + lat + " ms" : "") + " · resnapshots " + MON.resnapshots));
  chips.push(mChip("Position valuation", lost ? "bad" : !pos.length ? "ok" : stale ? "warnc" : "ok", lost ? "○ FROZEN" : !pos.length ? "● NO OPEN POSITIONS" : stale ? "◐ STALE INPUTS" : "● LIVE (backend)",
    lost ? "showing the last backend valuation from " + istHMS(v.calc_ts) + " " + TZ.label + "; not updated since" : "computed by the worker at " + istHMS(v.calc_ts) + " " + TZ.label + " · " + (v.valuation_method || "")));
  $("mStatus").innerHTML = chips.join("");
  var rt = MON.runtime;
  $("mBuild").innerHTML = rt ? "Worker build <b>" + esc(rt.build.revision) + (rt.build.dirty ? "+dirty" : "") + "</b> (source " + esc(rt.build.source_fingerprint) + ") · instance " + esc(rt.instance_id.slice(0, 8)) +
    " · started " + istT(rt.started_at) + " " + TZ.label + " · environment <b>" + esc(rt.database.environment) + "</b> · ledger database " + esc(rt.database.db_id.slice(0, 8)) + " · " + esc(rt.api_schema_version) + " / " + esc(v.schema_version) +
    " · strategies " + esc(Object.values(rt.strategy_versions).join(", ")) : "";
}
function renderMonitorAccounts() {
  var v = MON.val || MON.snap, A = v.accounts || [], frozen = MON.lost ? " frozen" : "";
  if (!A.length) { $("mAccounts").textContent = "No paper accounts."; return; }
  $("mAccounts").innerHTML = '<div class="profiles' + frozen + '" style="margin-top:0">' + A.map(function (a) {
    var unc = a.counts.closed_uncertain, row = function (k, val, tip) { return "<tr" + (tip ? ' title="' + esc(tip) + '"' : "") + "><td>" + k + '</td><td class="num">' + val + "</td></tr>"; };
    return '<div class="pf" style="cursor:default"><span class="nm">' + esc(a.analyst_name) + '</span><span class="tf">' + esc(a.strategy_version) + (a.kill_switch ? " · KILL SWITCH ON" : "") + "</span>" +
      '<table class="kv" style="margin-top:6px">' +
      row("Starting capital", mNum(a.starting_capital, 2) + " USDT") +
      row("Cash balance", mNum(a.cash_balance, 4), "start + realised gross − booked fees + settled funding") +
      row("Unrealised at mark (gross)", '<span class="' + mCls(a.unrealized_mark) + '">' + mSigned(a.unrealized_mark, 4) + "</span>") +
      row("Mark equity", "<b>" + mNum(a.mark_equity, 4) + "</b>", "cash balance + unrealised at mark") +
      row("Reserved margin", mNum(a.reserved_margin, 2), a.margin_model) + row("Available balance", mNum(a.available_balance, 2), "cash − reserved margin (simulator convention)") +
      row("Realised gross / fees / funding", mSigned(a.realized_gross, 4) + " / −" + mNum(a.fees_booked, 4) + " / " + mSigned(a.funding_settled, 4)) +
      row("Realised net", '<span class="' + mCls(a.realized_net) + '">' + mSigned(a.realized_net, 4) + "</span>") +
      row("Return on starting capital", mSigned(a.portfolio_return_pct_of_starting_capital, 3) + "%") +
      row("Drawdown from peak mark equity", mNum(a.drawdown_pct, 3) + "%") +
      row("Positions open / closed", a.counts.open + " / " + a.counts.closed) +
      row("Uncertain (data gap)", (a.counts.open_gap_affected + unc) + " trades" + (a.counts.closed ? " · " + Math.round(a.counts.uncertain_share * 100) + "% of closed" : "") + " · exposure " + mNum(a.unresolved_exposure_usdt, 2), "kept in the account; excluded only from evaluable metrics") +
      row("Net result: all closed / evaluable only", mSigned(a.results.net_all_closed, 4) + " / " + mSigned(a.results.net_evaluable, 4)) +
      "</table>" + '<div class="rec">Valuation ' + esc(a.valuation_status) + " · cash " + (a.cash_reconciles ? "reconciles with fills" : '<b class="down">DOES NOT RECONCILE with fills</b>') + " · <b>No demonstrated edge</b></div></div>";
  }).join("") + "</div>" + '<div class="sub" style="margin-top:6px">' + esc(v.structure || (MON.snap && MON.snap.structure) || "") + " Daily accounting boundary: 00:00 UTC.</div>";
}
function renderMonitorPositions() {
  var v = MON.val || MON.snap, P = v.positions || [];
  $("mPosAsOf").textContent = "· backend valuation at " + istHMS(v.calc_ts) + " " + TZ.label + (MON.lost ? " — FROZEN (worker not reachable)" : "");
  if (!P.length) { $("mPositions").innerHTML = "<b>No open paper positions.</b> Nothing is shown here unless the worker's engine actually opened it. See “Why there is or is not a trade” below for the last decisions and the conditions that blocked an entry."; return; }
  var head = "<tr><th>Analyst · strategy</th><th>Instrument</th><th>Side · state</th><th>Entered (" + TZ.label + ") · held</th><th class=\"r\">Fill price</th><th class=\"r\">Quantity · notional</th><th class=\"r\">Margin (sim.)</th><th class=\"r\">Stop / target</th>" +
    "<th class=\"r\" title=\"s × q × (mark − entry). Gross: no fees, no funding.\">Unrealised at mark (gross)</th><th class=\"r\" title=\"Estimate: realised + depth-weighted close of the remainder − all fees + settled funding. Not a fill.\">Net if closed now (est.)</th>" +
    "<th class=\"r\">Fees paid · funding · est. exit fee</th><th class=\"r\">Open risk · to stop</th><th>Mark / book age</th><th>Trade · evidence</th></tr>";
  $("mPositions").innerHTML = '<table class="' + (MON.lost ? "frozen" : "") + '">' + head + P.map(function (p) {
    var x = p.valuation || {}, d = mDp(p.entry_fill_price), pct = x.pct || {}, cn = x.close_now || {};
    var st = p.state + (p.data_state !== "COMPLETE" ? " · UNRESOLVED PATH (data gap)" : "");
    return '<tr class="mrow" tabindex="0" data-pid="' + esc(p.position_id) + '" title="Open position detail"><td><b>' + esc(M_AN[p.analyst] || p.analyst) + "</b><br><span class=\"sub\">" + esc(p.strategy_version || "") + "</span></td>" +
      "<td>" + esc(p.symbol) + '<br><span class="sub">' + esc(p.venue) + " · " + esc(p.inst_class) + "</span></td>" +
      '<td><b class="' + (p.side > 0 ? "up" : "down") + '">' + esc(p.direction) + '</b><br><span class="sub' + (p.data_state !== "COMPLETE" ? " warn" : "") + '">' + esc(st) + "</span></td>" +
      "<td>" + istT(p.opened_ts) + '<br><span class="sub">' + mDur(p.duration_ms) + "</span></td>" +
      '<td class="num">' + mNum(p.entry_fill_price, d) + '<br><span class="sub">recorded sim. fill</span></td>' +
      '<td class="num">' + esc(String(p.remaining_qty)) + " " + esc(p.qty_unit || "") + '<br><span class="sub">' + mNum(p.remaining_entry_notional, 2) + " USDT</span></td>" +
      '<td class="num">' + mNum(p.margin.reserved, 2) + '<br><span class="sub">' + esc(String(p.margin.leverage_setting)) + "× setting</span></td>" +
      '<td class="num"><span class="down">' + mNum(p.stop, d) + '</span><br><span class="up">' + mNum(p.target, d) + "</span></td>" +
      '<td class="num"><b class="' + mCls(x.u_mark) + '">' + mSigned(x.u_mark, 4) + "</b>" + (x.u_mark_is_stale ? ' <span class="pill bad">stale mark</span>' : "") + '<br><span class="sub">' + mSigned(pct.gross_unrealized_pct_of_entry_notional, 3) + "% of entry notional · " + mSigned(pct.gross_unrealized_pct_of_initial_margin, 3) + "% of margin</span></td>" +
      '<td class="num"><b class="' + mCls(x.lifecycle_if_closed_now) + '">' + mSigned(x.lifecycle_if_closed_now, 4) + '</b><br><span class="sub">' + (cn.status === "OK" ? "close ≈ " + mNum(cn.x, d) + (cn.is_stale ? " (stale book)" : "") : cn.status === "PARTIAL_LIQUIDITY" ? "book covers only " + Math.round(cn.coverage * 100) + "%" : esc(cn.status || "UNAVAILABLE")) + "</span></td>" +
      '<td class="num">−' + mNum(p.fees_paid, 4) + " · " + mSigned(p.funding_settled, 4) + '<br><span class="sub">exit fee est. ' + (cn.exit_fee_est === null || cn.exit_fee_est === undefined ? "N/A" : "−" + mNum(cn.exit_fee_est, 4)) + "</span></td>" +
      '<td class="num">' + mNum(p.open_risk_usdt, 4) + '<br><span class="sub">' + mNum(p.distance_to_invalidation_pct, 3) + "% to stop</span></td>" +
      "<td>" + esc(x.mark ? x.mark.status : "N/A") + " " + mAge(x.mark ? x.mark.age_ms : null) + '<br><span class="sub">book ' + esc(x.book ? x.book.status : "N/A") + " " + mAge(x.book ? x.book.age_ms : null) + "</span></td>" +
      '<td class="sub">' + esc(mShort(p.trade_id)) + "<br>ev " + esc((p.evidence_hash || "").slice(0, 8)) + "</td></tr>";
  }).join("") + "</table>" + '<div class="sub" style="margin-top:6px">Mark, last, bid and ask are different prices. “Unrealised at mark” is gross. “Net if closed now” is an estimate from current book depth, not a guaranteed fill. Leverage only sets the margin; it never multiplies P&L. Click a row (or press Enter) for the full record.</div>';
  $("mPositions").querySelectorAll(".mrow").forEach(function (r) { r.onclick = function () { monitorOpenDetail(r.dataset.pid); }; r.onkeydown = function (e) { if (e.key === "Enter") monitorOpenDetail(r.dataset.pid); }; });
}
function mEventText(e) {
  var p = e.payload || {};
  if (e.type === "SETUP_CANDIDATE") return "Candidate setup: " + p.intent + " — " + (p.why || "");
  if (e.type === "DECISION_ABSTAIN") return p.intent + " (" + p.code + ") — " + (p.why || "");
  if (e.type === "RISK_APPROVED") return "Risk gate approved" + (p.size ? ": qty " + p.size.qty_str + ", modelled risk " + mNum(p.size.risk_usdt, 3) + " USDT" : "");
  if (e.type === "RISK_REJECTED") return "Risk gate rejected: " + (p.reasons || []).join(", ");
  if (e.type === "FILL") return "Simulated " + (p.kind === "ENTRY" ? "entry" : "exit (" + p.reason + ")") + " fill: " + p.qty + " @ " + p.price + ", fee " + mNum(p.fee, 4);
  if (e.type === "POSITION_CLOSED") return "Position closed (" + p.reason + "): net " + mSigned(p.net_usdt, 4) + " USDT" + (p.evaluable ? "" : " — outcome NOT evaluable (data gap)");
  if (e.type === "FUNDING") return "Funding posted: " + mSigned(p.amount, 4) + " USDT at rate " + p.rate;
  if (e.type === "FUNDING_UNKNOWN") return "Funding settlement with no observed rate: nothing booked";
  if (e.type === "DATA_GAP") return "Data gap: " + (p.why || "") + " — " + (p.policy || "");
  if (e.type === "KILL_SWITCH_ON" || e.type === "KILL_SWITCH_OFF") return e.type.replace(/_/g, " ") + ": " + (p.effect || "");
  if (e.type === "RECONCILIATION_FAILURE") return "RECONCILIATION FAILURE: stored cash " + p.stored_cash + " vs facts " + p.cash_from_fills_and_funding;
  if (e.type === "ENGINE_START") return "Paper engine started (" + (p.engine || "") + ", " + (p.environment || "") + ")";
  return e.type;
}
function renderMonitorActivity() {
  if (!$("mActivity")) return;
  var types = Array.from(new Set(MON.events.map(function (e) { return e.type; }))).sort(), sel = $("mFType"), cur = sel.value;
  if (sel.options.length !== types.length + 1) { sel.innerHTML = '<option value="">all</option>' + types.map(function (t) { return "<option>" + esc(t) + "</option>"; }).join(""); sel.value = cur; }
  var fa = $("mFAnalyst").value, fc = $("mFCoin").value;
  var L = MON.events.filter(function (e) { return (!cur || e.type === cur) && (!fa || e.analyst === fa) && (!fc || (e.instrument_id || "").endsWith(":" + fc)); }).slice(0, 80);
  if (!L.length) { $("mActivity").textContent = MON.events.length ? "No events match the filters." : "No activity recorded yet."; return; }
  $("mActivity").innerHTML = "<table><tr><th>#</th><th>Event time (" + TZ.label + ")</th><th>Recorded</th><th>Type</th><th>Analyst</th><th>Coin</th><th>What happened</th><th>IDs</th></tr>" + L.map(function (e) {
    var lag = e.recorded_ts - e.ts;
    return "<tr><td>" + e.seq + '</td><td style="white-space:nowrap">' + istT(e.ts) + ":" + new Date(e.ts + TZ.ms).toISOString().slice(17, 19) + '</td><td class="sub">' + (Math.abs(lag) < 1000 ? "same second" : "+" + mAge(lag)) + "</td><td><b>" + esc(e.type.replace(/_/g, " ")) + "</b></td><td>" + esc(M_AN[e.analyst] || e.analyst || "—") +
      "</td><td>" + esc((e.instrument_id || "").split(":")[2] || "—") + "</td><td>" + esc(mEventText(e)) + '</td><td class="sub">' + (e.position_id ? '<a href="#" data-pid="' + esc(e.position_id) + '">' + esc(mShort(e.position_id)) + "</a>" : esc(mShort(e.decision_id))) + "</td></tr>";
  }).join("") + "</table>" + '<div class="sub" style="margin-top:6px">Durable events from the worker’s outbox (cursor ' + MON.cursor + "). Event time is when it happened in the market or bar clock; “recorded” is when the worker wrote it.</div>";
  $("mActivity").querySelectorAll("a[data-pid]").forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); monitorOpenDetail(a.dataset.pid); }; });
}
function renderMonitorDiag() {
  if (!$("mDiag")) return; $("mDiagSym").textContent = sym.replace("USDT", "") + " perpetual";
  var D = MON.diag; if (!D) { $("mDiag").textContent = "Waiting for diagnostics…"; return; }
  var id = "bitget:perp:" + sym, rows = D.rows.filter(function (r) { return r.instrument_id === id && r.analyst; }), w = D.rows.find(function (r) { return r.instrument_id === id && r.warmup; });
  var e = D.engine || {};
  $("mDiag").innerHTML = '<div class="profiles" style="margin-top:0">' + rows.map(function (r) {
    var d = r.last_decision, P = r.predicates;
    return '<div class="pf" style="cursor:default"><span class="nm">' + esc(M_AN[r.analyst]) + "</span>" + (d ? '<div class="sg ' + (d.intent.indexOf("OPEN") === 0 ? (d.intent === "OPEN_LONG" ? "s-buy" : "s-sell") : d.intent === "WAIT" ? "s-wait" : "s-none") + '" style="font-size:18px">' + esc(d.intent.replace("_", " ")) + " · " + esc(d.code) +
      '</div><div class="sub">' + esc(d.why || "") + " · bar closed " + istT(d.bar_close_ts) + " " + TZ.label + ", decided +" + mAge(d.decided_ts - d.bar_close_ts) + "</div>" : '<div class="sub">No decision for this coin yet in this ledger.</div>') +
      (P ? '<table style="margin-top:6px">' + P.predicates.map(function (x) { return "<tr><td>" + (x.pass === true ? '<span class="up">✓ met</span>' : x.pass === false ? '<span class="down">✗ not met</span>' : '<span class="muted">? unknown</span>') + "</td><td>" + esc(x.name) + '</td><td class="sub">' + esc(x.detail || "") + "</td></tr>"; }).join("") + "</table>" +
        (P.blocking ? '<div class="rec">Blocked by: <b>' + esc(P.blocking) + "</b></div>" : '<div class="rec">All entry conditions met on that bar.</div>') : "") + "</div>";
  }).join("") + "</div>" + '<div class="sub" style="margin-top:8px">Scheduler: engine ' + esc(e.state || "?") + " · decisions since this worker started: " + (e.decisions || 0) + " bar-coin runs" +
    (w ? " · warm-up: " + w.warmup.final_15m_bars + " final 15m bars stored (needs " + w.warmup.required + (w.warmup.satisfied ? ", satisfied)" : ", NOT yet satisfied)") : "") +
    " · all decisions in this ledger: " + esc((D.decisions_by_outcome || []).map(function (x) { return x.intent + "/" + x.code + " ×" + x.n; }).join(", ") || "none") +
    ". Waiting is the normal result on most bars; criteria are never loosened to produce a trade.</div>";
}
function renderMonitorClosed() {
  if (!$("mClosed")) return; var C = MON.closed || [];
  if (!C.length) { $("mClosed").textContent = "No closed paper positions in this ledger."; return; }
  $("mClosed").innerHTML = "<table><tr><th>Closed (" + TZ.label + ")</th><th>Analyst</th><th>Coin</th><th>Side</th><th class=\"r\">Entry → exit</th><th>Exit</th><th class=\"r\">Gross</th><th class=\"r\">Fees</th><th class=\"r\">Funding</th><th class=\"r\">Net</th><th>Metric eligibility</th></tr>" + C.map(function (p) {
    var d = mDp(p.entry_fill_price), c = p.closed;
    return '<tr class="mrow" tabindex="0" data-pid="' + esc(p.position_id) + '"><td>' + istT(c.exit_ts) + "</td><td>" + esc(M_AN[p.analyst] || p.analyst) + "</td><td>" + esc(p.symbol) + '</td><td class="' + (p.side > 0 ? "up" : "down") + '">' + esc(p.direction) + '</td><td class="num">' + mNum(p.entry_fill_price, d) + " → " + mNum(c.exit_price, d) +
      "</td><td>" + esc(c.reason) + '</td><td class="num">' + mSigned(p.realized_gross, 4) + '</td><td class="num">−' + mNum(p.fees_paid, 4) + '</td><td class="num">' + mSigned(p.funding_settled, 4) + '</td><td class="num"><b class="' + mCls(c.net_usdt) + '">' + mSigned(c.net_usdt, 4) + "</b></td><td>" +
      (c.evaluable ? "evaluable" : '<span class="warn">UNCERTAIN (data gap): in the account, excluded from win/expectancy metrics</span>') + "</td></tr>";
  }).join("") + "</table>";
  $("mClosed").querySelectorAll(".mrow").forEach(function (r) { r.onclick = function () { monitorOpenDetail(r.dataset.pid); }; r.onkeydown = function (e) { if (e.key === "Enter") monitorOpenDetail(r.dataset.pid); }; });
}
function renderMonitorRegistry() {
  if (!$("mRegistry") || !MON.registry) return; var R = MON.registry, J = MON.jobs || {};
  $("mRegistry").innerHTML = "<table><tr><th>ID · version</th><th>Type</th><th>Training</th><th>Validation evidence</th><th>Edge</th><th>State</th><th>Known weaknesses</th></tr>" + R.strategies.map(function (s) {
    return "<tr><td><b>" + esc(s.name) + "</b><br><span class=\"sub\">" + esc(s.version) + " · features " + esc(s.feature_schema) + "</span></td><td>" + esc(s.type) + "</td><td>" + esc(s.training.replace(/_/g, " ")) + "</td><td class=\"sub\">" + esc(s.validation) + "</td><td><b>" + esc(s.edge.replace(/_/g, " ")) + "</b></td><td>" + esc(s.deployment_state.replace(/_/g, " ")) + '</td><td class="sub">' + esc(s.known_weaknesses.join("; ")) + "</td></tr>";
  }).join("") + "</table>" + '<div style="margin-top:8px">' + esc(R.model_note) + " Legacy: " + esc(R.legacy.map(function (l) { return l.id + " (" + l.state + ", " + l.calibration + ")"; }).join("; ")) + ".</div>" +
    '<div style="margin-top:6px"><b>Research / training jobs:</b> ' + esc(J.training_backend === "UNAVAILABLE" ? "Training backend unavailable." : String(J.training_backend || "unknown")) + " " + esc(J.note || "") + "</div>";
}

// ------------------------------------------------------------------ position detail
async function monitorOpenDetail(pid) {
  MON.detailId = pid; $("mDetailCard").classList.remove("hidden");
  try { MON.detail = await apiJson("api/paper/position?id=" + encodeURIComponent(pid)); } catch (e) { $("mDetail").textContent = "Detail unavailable (worker not reachable or unknown position)."; return; }
  var D = MON.detail, p = D.position, dec = D.decision || {}, su = dec.setup || {}, d = mDp(p.entry_fill_price), ev = D.evidence || {};
  var list = function (a) { return a && a.length ? "<ul style=\"margin:2px 0 0;padding-left:18px\">" + a.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : '<span class="muted">none recorded</span>'; };
  $("mDetail").innerHTML = '<div class="row"><div><table class="kv">' +
    "<tr><td>Trade / position ID</td><td>" + esc(p.position_id) + "</td></tr><tr><td>Analyst · strategy</td><td>" + esc(M_AN[p.analyst] || p.analyst) + " · " + esc(p.strategy_version || "") + "</td></tr>" +
    "<tr><td>Instrument</td><td>" + esc(p.symbol) + " · " + esc(p.venue) + " · " + esc(p.inst_class) + " · " + esc(p.direction) + "</td></tr>" +
    "<tr><td>State · data</td><td>" + esc(p.state) + " · " + esc(p.data_state) + (p.note ? " — " + esc(p.note) : "") + "</td></tr>" +
    "<tr><td>Decision</td><td>" + esc(dec.intent || "") + " (" + esc(dec.code || "") + ") for bar " + (dec.bar_close_ts ? istT(dec.bar_close_ts) : "?") + " " + TZ.label + " — " + esc(dec.why || "") + "</td></tr>" +
    "<tr><td>Supporting observations</td><td>" + list(su.supporting) + "</td></tr><tr><td>Contradicting observations</td><td>" + list(su.contradicting) + "</td></tr>" +
    "<tr><td>Evidence snapshot</td><td>" + esc((dec.evidence_hash || "").slice(0, 16)) + "… · trend " + esc(String(ev.trend_1h)) + " · ATR pctile " + esc(ev.atr_pctile === null || ev.atr_pctile === undefined ? "n/a" : Number(ev.atr_pctile).toFixed(2)) + " · spread " + esc(ev.spread_bps === null || ev.spread_bps === undefined ? "n/a" : Number(ev.spread_bps).toFixed(3)) + " bps" + (ev.fixture ? ' · <b class="down">' + esc(ev.fixture) + "</b>" : "") + "</td></tr>" +
    "<tr><td>Stop / target changes</td><td>" + esc(D.stop_target_changes.note) + "</td></tr></table></div><div>" +
    "<b>Risk and lifecycle history (ledger)</b><table>" + D.ledger_history.map(function (h) { return "<tr><td>" + istT(h.created_ts) + "</td><td>" + esc(h.kind) + "</td><td>" + esc(h.payload.state || h.payload.intent || h.payload.result || "") + '</td><td class="sub">' + esc((h.payload.reasons || []).join(", ") || h.payload.reason || "") + "</td></tr>"; }).join("") + "</table>" +
    '<b style="display:block;margin-top:8px">Fills</b><table><tr><th>Time</th><th>Kind</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fee</th><th>Model / reason</th></tr>' + D.fills.map(function (f) { return "<tr><td>" + istT(f.ts) + "</td><td>" + esc(f.kind) + '</td><td class="num">' + esc(f.qty) + '</td><td class="num">' + mNum(f.price, d) + '</td><td class="num">−' + mNum(f.fee, 4) + '</td><td class="sub">' + esc(f.reason || "") + " · " + esc(f.model || "") + "</td></tr>"; }).join("") + "</table>" +
    '<b style="display:block;margin-top:8px">Funding postings</b>' + (D.funding.length ? "<table>" + D.funding.map(function (f) { return "<tr><td>" + istT(f.settlement_ts) + '</td><td class="num">rate ' + esc(String(f.rate)) + '</td><td class="num">' + mSigned(f.amount, 4) + " USDT</td></tr>"; }).join("") + "</table>" : '<div class="sub">none settled while open</div>') +
    '<b style="display:block;margin-top:8px">Data gaps while open</b>' + (D.data_gaps.length ? "<table>" + D.data_gaps.map(function (g) { return "<tr><td>" + esc(g.kind) + "</td><td>" + istT(g.from_ts) + " → " + istT(g.to_ts) + "</td><td>" + esc(g.reason) + "</td></tr>"; }).join("") + "</table>" : '<div class="sub">none recorded</div>') + "</div></div>";
  $("mChartNote").textContent = "Price since entry: stored 1-minute candles from the worker" + (D.chart.missing_ranges.length ? " · " + D.chart.missing_ranges.length + " missing range(s) are left EMPTY (marked ▲), not interpolated" : " · no missing ranges") + ". Lines: entry (white), stop (red), target (green).";
  if (!MON.chart) { MON.chart = LightweightCharts.createChart($("mChart"), { autoSize: true, layout: { background: { color: "#171a21" }, textColor: "#8b93a3" }, grid: { vertLines: { color: "#1f232c" }, horzLines: { color: "#1f232c" } }, timeScale: { timeVisible: true, borderColor: "#262b35" }, rightPriceScale: { borderColor: "#262b35" } });
    MON.series = MON.chart.addCandlestickSeries({ upColor: "#2fbf71", downColor: "#e5484d", borderVisible: false, wickUpColor: "#2fbf71", wickDownColor: "#e5484d" }); MON.lines = []; }
  var tm = function (t) { return (t + TZ.ms) / 1000; };
  MON.series.applyOptions({ priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) } });
  MON.series.setData(D.chart.candles.map(function (c) { return { time: tm(c.open_ts), open: +c.o, high: +c.h, low: +c.l, close: +c.c }; }));
  var marks = D.chart.missing_ranges.map(function (g) { return { time: tm(g.after), position: "aboveBar", color: "#f5a524", shape: "arrowDown", text: "data gap" }; });
  var first = D.chart.candles.find(function (c) { return c.open_ts + 60000 > p.opened_ts; }); if (first) marks.push({ time: tm(first.open_ts), position: "belowBar", color: "#e7e9ee", shape: "arrowUp", text: "entry" });
  MON.series.setMarkers(marks.sort(function (a, b) { return a.time - b.time; }));
  MON.lines.forEach(function (l) { MON.series.removePriceLine(l); }); MON.lines = [];
  [[p.entry_fill_price, "#e7e9ee", "entry fill"], [p.stop, "#e5484d", "stop"], [p.target, "#2fbf71", "target"]].forEach(function (x) { MON.lines.push(MON.series.createPriceLine({ price: x[0], color: x[1], lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: x[2] })); });
  MON.chart.timeScale().fitContent();
  $("mDetailCard").scrollIntoView({ block: "nearest" });
}
document.addEventListener("DOMContentLoaded", function () {
  $("mDetailClose").onclick = function () { MON.detailId = null; $("mDetailCard").classList.add("hidden"); };
  ["mFType", "mFAnalyst", "mFCoin"].forEach(function (k) { $(k).onchange = renderMonitorActivity; });
});
