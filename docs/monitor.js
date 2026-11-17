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
    MON.runtime = r[0]; MON.snap = r[1]; MON.val = r[1]; MON.tomb = {}; (r[1].recent_closed || []).forEach(function (c) { monitorTomb(c.position_id, c.closed && c.closed.exit_ts); }); MON.cursor = r[1].cursor; MON.events = r[1].recent_activity.slice(); MON.closed = r[1].recent_closed;
    MON.lastFrame = Date.now(); MON.lost = false; MON.resnapshots++; MON.lastResnapshot = why;
    monitorOpenStream(); renderMonitor(true);
    if (MON.detailId) monitorOpenDetail(MON.detailId);
  } catch (e) { MON.conn = "DISCONNECTED"; renderMonitor(true); }
}
/* Ordering and tombstones for the live valuation. A valuation frame older than the one on screen is dropped (the display never rolls back), and a position known to be
 * closed (from a snapshot's recent_closed or a POSITION_CLOSED event) is removed from every later frame, so a late or replayed frame cannot resurrect it. Position ids are
 * unique and a closed position never reopens, so the tombstone set is safe to keep for the page's lifetime. Authoritative resnapshots reset the set from the backend. */
function monitorTomb(id, ts) { if (!MON.tomb) MON.tomb = {}; if (id) MON.tomb[id] = ts || Date.now(); }
function monitorAcceptValuation(frame) {
  if (!frame || typeof frame.calc_ts !== "number") { MON.rejected = (MON.rejected || 0) + 1; return false; }
  if (MON.val && typeof MON.val.calc_ts === "number" && frame.calc_ts < MON.val.calc_ts) { MON.staleDropped = (MON.staleDropped || 0) + 1; return false; }
  if (MON.tomb && Array.isArray(frame.positions)) { var n = frame.positions.length; frame.positions = frame.positions.filter(function (p) { return !MON.tomb[p.position_id]; }); if (frame.positions.length !== n) MON.tombFiltered = (MON.tombFiltered || 0) + (n - frame.positions.length); }
  MON.val = frame; return true;
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
    if (ev.type === "POSITION_CLOSED") { monitorTomb(ev.position_id, ev.ts); if (MON.val && MON.val.positions) MON.val.positions = MON.val.positions.filter(function (p) { return p.position_id !== ev.position_id; }); }
    MON.cursor = ev.seq; MON.events.unshift(ev); if (MON.events.length > 400) MON.events.length = 400;
    MON.lat.push(Date.now() - ev.recorded_ts); if (MON.lat.length > 50) MON.lat.shift();
    if (ev.type === "POSITION_CLOSED" || ev.type === "FILL") monitorSlow();
    renderMonitorActivity();
  });
  es.addEventListener("valuation", function (e) { monitorAcceptValuation(JSON.parse(e.data)); MON.lastFrame = Date.now(); MON.conn = "STREAMING"; MON.lost = false; MON.dirty = true; });
  es.addEventListener("resnapshot", function () { monitorResnapshot("server asked for a resnapshot"); });
  es.onerror = function () { MON.conn = es.readyState === 2 ? "DISCONNECTED" : "RECONNECTING"; };
}
/** Once a second: staleness check, polling fallback, throttled repaint (rendering is independent of event arrival). */
function monitorTick() {
  if (!MON.started) return;
  var age = Date.now() - MON.lastFrame;
  if (MON.snap && age > 5000 && !MON.lost) { MON.lost = true; MON.dirty = true; }
  if (MON.conn === "POLLING" && WMODE && age > 2000) apiJson("api/paper/snapshot").then(function (s) { monitorAcceptValuation(s); MON.lastFrame = Date.now(); MON.lost = false; MON.dirty = true; }).catch(function () {});
  if (MON.lost && WMODE === false && MON.es && MON.es.readyState === 2) MON.conn = "DISCONNECTED";
  if (view !== "monitor") return;
  if (MON.dirty || MON.lost) { MON.dirty = false; renderMonitor(false); }
  else if (MON.snap) renderMonitorStatus();                  // ages and connection state repaint every second regardless of frames
}
function monitorLost() { MON.lost = true; MON.conn = "DISCONNECTED"; if (view === "monitor") renderMonitor(false); }
async function monitorSlow() {
  if (!WMODE) return;
  try { var r = await Promise.all([apiJson("api/paper/diagnostics"), apiJson("api/paper/closed?limit=300"), MON.registry ? null : apiJson("api/registry"), MON.jobs ? null : apiJson("api/jobs")]);
    MON.diag = r[0]; MON.closed = r[1].closed; MON.closedTotal = r[1].closed_total; if (r[2]) MON.registry = r[2]; if (r[3]) MON.jobs = r[3];
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
      row("Est. closeout equity", a.closeout && a.closeout.equity_estimate !== null ? mNum(a.closeout.equity_estimate, 4) : '<span class="muted">' + (a.closeout && a.closeout.positions_open ? "N/A" : mNum(a.cash_balance, 4)) + "</span>", a.closeout ? a.closeout.basis + (a.closeout.reason ? " · unavailable: " + a.closeout.reason : "") : "") +
      row("Open exposure", a.exposure && a.exposure.gross_notional_at_mark !== null ? mNum(a.exposure.gross_notional_at_mark, 2) + " USDT · " + (a.exposure.notional_over_mark_equity === null ? "N/A" : mNum(a.exposure.notional_over_mark_equity, 3) + "× equity") : "0.00 USDT", a.exposure ? a.exposure.basis : "") +
      row("Pricing", a.pricing ? esc(a.pricing.completeness) + (a.pricing.oldest_mark_age_ms !== null ? " · oldest mark " + mAge(a.pricing.oldest_mark_age_ms) : "") : "N/A", "open positions with a mark / with an executable close estimate; stale inputs are counted separately") +
      row("Reserved margin", mNum(a.reserved_margin, 2), a.margin_model) + row("Available balance", mNum(a.available_balance, 2), "cash − reserved margin (simulator convention)") +
      row("Realised gross / fees / funding", mSigned(a.realized_gross, 4) + " / −" + mNum(a.fees_booked, 4) + " / " + mSigned(a.funding_settled, 4)) +
      row("Realised net", '<span class="' + mCls(a.realized_net) + '">' + mSigned(a.realized_net, 4) + "</span>") +
      row("Account return", mSigned(a.account_return ? a.account_return.value_pct : a.portfolio_return_pct_of_starting_capital, 3) + "%", a.account_return ? a.account_return.definition + " · denominator " + mNum(a.account_return.denominator_usdt, 2) + " USDT · " + a.account_return.capital_flow_assumption : "") +
      row("Drawdown from peak mark equity", mNum(a.drawdown_pct, 3) + "%") +
      row("Max drawdown (recorded)", a.drawdown_recorded && a.drawdown_recorded.max_pct !== null ? mSigned(a.drawdown_recorded.max_pct, 3) + "%" : '<span class="muted">N/A</span>', a.drawdown_recorded ? a.drawdown_recorded.basis : "") +
      row("Drawdown coverage", a.drawdown_recorded && a.drawdown_recorded.samples ? a.drawdown_recorded.samples + " samples since " + istT(a.drawdown_recorded.first_ts) + (a.drawdown_recorded.largest_gap_ms > 150000 ? " · largest gap " + mDur(a.drawdown_recorded.largest_gap_ms) : "") : "none recorded yet", "recorded once a minute while the worker runs; not back-filled") +
      row("Positions open / closed", a.counts.open + " / " + a.counts.closed) +
      row("Uncertain (data gap)", (a.counts.open_gap_affected + unc) + " trades" + (a.counts.closed ? " · " + Math.round(a.counts.uncertain_share * 100) + "% of closed" : "") + " · exposure " + mNum(a.unresolved_exposure_usdt, 2), "kept in the account; excluded only from evaluable metrics") +
      row("Net result: all closed / evaluable only", mSigned(a.results.net_all_closed, 4) + " / " + mSigned(a.results.net_evaluable, 4)) +
      "</table>" + '<div class="rec">Valuation ' + esc(a.valuation_status) + " · cash " + (a.cash_reconciles ? "reconciles with fills" : '<b class="down">DOES NOT RECONCILE with fills</b>') + " · <b>No demonstrated edge</b></div></div>";
  }).join("") + "</div>" + '<div class="sub" style="margin-top:6px">' + esc(v.structure || (MON.snap && MON.snap.structure) || "") + " Daily accounting boundary: 00:00 UTC.</div>";
}
/* ---- Open positions (live-metrics-v1). RENDER ONLY: every number, sign class, ROI and denominator below comes from the backend's position.live block. ---- */
var OP_CLS = { GAIN: "up", LOSS: "down", FLAT: "muted", UNAVAILABLE: "muted" };
function opMoney(v, d) { return v === null || v === undefined ? "N/A" : mSigned(v, d === undefined ? 4 : d) + " USDT"; }
function opFig(label, valueHtml, subHtml, f) { return '<div class="opf"><div class="oplbl">' + label + '</div><div class="opbig" data-f="' + f + '">' + valueHtml + "</div>" + (subHtml ? '<div class="sub">' + subHtml + "</div>" : "") + "</div>"; }
function opRow(k, v, tip) { return "<tr" + (tip ? ' title="' + esc(tip) + '"' : "") + "><td>" + k + '</td><td class="num">' + v + "</td></tr>"; }
function renderMonitorPositions() {
  var v = MON.val || MON.snap, P = v.positions || [];
  $("mPosAsOf").textContent = "· backend valuation at " + istHMS(v.calc_ts) + " " + TZ.label + (MON.lost ? " — FROZEN (worker not reachable)" : "");
  if (!P.length) { $("mPositions").innerHTML = "<b>No open paper positions.</b> Nothing is shown here unless the worker's engine actually opened it. See “Why there is or is not a trade” below for the last decisions and the conditions that blocked an entry."; return; }
  $("mPositions").innerHTML = '<div class="opgrid' + (MON.lost ? " frozen" : "") + '">' + P.map(function (p) {
    var L = p.live, d = mDp(p.entry_fill_price), x = p.valuation || {}, an = M_AN[p.analyst] || p.analyst;
    var head = '<div class="ophead"><span><b>' + esc(an) + '</b> <span class="sub">' + esc(p.strategy_version || "") + " · account paper:" + esc(p.analyst) + '</span></span><span><b class="opsym">' + esc(p.symbol) + '</b> <b class="dir ' + (p.side > 0 ? "up" : "down") + '">' + esc(p.direction) + "</b></span></div>";
    if (!L) return '<div class="opcard mrow" tabindex="0" data-pid="' + esc(p.position_id) + '">' + head + '<div class="warn">This worker build does not provide the live-metrics block; restart it on the current build to see margin, ROI and freshness.</div></div>';
    var pr = L.prices, roi = L.roi.filter(function (r) { return r.primary; })[0], nw = L.net_if_closed.whole_trade, rl = L.net_if_closed.remaining_leg, gc = OP_CLS[L.gross_unrealized.class];
    var chips = "";
    if (p.data_state !== "COMPLETE") chips += '<span class="pill bad" title="a trade-feed gap occurred while this position was open">UNRESOLVED PATH (data gap)</span> ';
    if (pr.mark_status === "STALE") chips += '<span class="pill bad">STALE MARK · last valid value shown</span> '; else if (pr.mark_status === "UNAVAILABLE") chips += '<span class="pill bad">MARK UNAVAILABLE</span> ';
    if (pr.book_status === "STALE") chips += '<span class="pill bad">STALE BOOK · close estimate is old</span> '; else if (pr.close_status === "PARTIAL_LIQUIDITY") chips += '<span class="pill bad">BOOK TOO THIN FOR THE FULL SIZE</span> '; else if (pr.close_status !== "OK") chips += '<span class="pill unknown">CLOSE ESTIMATE UNAVAILABLE</span> ';
    var figs = opFig("Gross P&L at mark", '<span class="' + gc + '">' + opMoney(L.gross_unrealized.value, 4) + "</span>", "unrealised · before fees and funding", "gross") +
      opFig("ROI · gross, on initial margin", roi && roi.value !== null ? '<span class="' + gc + '">' + mSigned(roi.value, 2) + "%</span>" : '<span class="muted">N/A</span>',
        roi && roi.value !== null ? "÷ " + mNum(roi.denominator_usdt, 2) + " USDT initial margin" : esc(roi ? roi.reason : ""), "roi") +
      opFig("Est. net if closed now", nw ? '<span class="' + OP_CLS[nw.class] + '">' + opMoney(nw.net, 4) + "</span>" : '<span class="muted">N/A</span>',
        nw ? "whole trade, after all fees · close ≈ " + mNum(pr.estimated_close, d) : esc(L.net_if_closed.status === "PARTIAL_LIQUIDITY" ? "book covers only " + Math.round((x.close_now || {}).coverage * 100) + "% of the size" : "no executable estimate (" + esc(L.net_if_closed.status) + ")"), "net");
    var cm = L.margin, nt = L.notional, rb = L.risk_budget, rbv = rb.gross_unrealized_per_risk_budget;
    var rows = opRow("Entry → mark", mNum(pr.average_entry, d) + " → <b data-f=\"mark\">" + mNum(pr.mark, d) + "</b>", "recorded simulated fill; exchange mark price") +
      opRow("Margin allocated", "<b data-f=\"margin\">" + mNum(cm.allocated_now, 2) + " USDT</b>", "simulator: remaining entry-fill notional ÷ margin setting. A reservation of collateral, not a cost.") +
      opRow("Notional", "<span data-f=\"notional\">" + mNum(nt.remaining_at_entry, 2) + "</span> at entry · " + mNum(nt.at_mark, 2) + " at mark USDT", "quantity × price") +
      opRow("Leverage", esc(String(cm.margin_setting_leverage)) + "× margin setting · " + (cm.notional_at_mark_per_allocated_margin === null ? "N/A" : mNum(cm.notional_at_mark_per_allocated_margin, 2) + "× notional ÷ margin now"), "the setting only sets the margin; it never multiplies P&L") +
      opRow("Quantity", esc(String(p.remaining_qty)) + " " + esc(p.qty_unit || "")) +
      opRow("Stop / target", '<span class="down">' + mNum(p.stop, d) + '</span> / <span class="up">' + mNum(p.target, d) + "</span> · " + mNum(p.distance_to_invalidation_pct, 2) + "% to stop") +
      opRow("Risk budget", rb.recorded_usdt ? mNum(rb.recorded_usdt, 4) + " USDT recorded · P&L = " + (rbv.value === null ? "N/A" : mSigned(rbv.value, 1) + "% of it") : "not recorded", "initial risk budget from the ledger risk record, not the ROI denominator") +
      opRow("Fees · funding", "paid −" + mNum(p.fees_paid, 4) + " · settled " + mSigned(p.funding_settled, 4) + " · est. exit " + (nw && nw.exit_fee_est !== null ? "−" + mNum(nw.exit_fee_est, 4) : "N/A"), "booked fees and settled funding are in the net estimate; the estimated exit fee is too") +
      opRow("Next funding (est.)", L.unsettled_funding_estimate.usdt === null ? "N/A" : mSigned(L.unsettled_funding_estimate.usdt, 4) + " USDT, not included in any figure", L.unsettled_funding_estimate.label) +
      opRow("Held", mDur(p.duration_ms) + " · entered " + istT(p.opened_ts));
    var fresh = '<div class="opfresh" data-f="fresh">mark <b>' + esc(pr.mark_status) + "</b> " + mAge(pr.mark_age_ms) + " old · book <b>" + esc(pr.book_status) + "</b> " + mAge(pr.book_age_ms) + " old · valuation " + istHMS(L.freshness.calc_ts) + " " + TZ.label + "</div>";
    return '<div class="opcard mrow" tabindex="0" data-pid="' + esc(p.position_id) + '" role="button" title="Open position detail">' + head + (chips ? '<div class="opchips">' + chips + "</div>" : "") + '<div class="opfigs">' + figs + "</div>" +
      '<table class="kv optab">' + rows + "</table>" + fresh + "</div>";
  }).join("") + "</div>" + '<div class="sub" style="margin-top:6px">Mark, last, bid and ask are different prices. Gross P&L is at the exchange mark. ROI names its denominator; the primary ROI is gross P&L ÷ initial margin and other ROIs are in the position detail. “Est. net if closed now” is an estimate from current book depth, not a fill, and already includes every booked fee and the estimated exit fee. Values under ' + "0.005 USDT are shown as flat. Click a card (or press Enter) for the full record.</div>";
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
/* Closed-position history with filters. RENDER ONLY: gross, fees, funding, net, margin basis and the ROI with its named denominator come from the backend (position.closed).
 * Filters apply to the rows loaded from /api/paper/closed (newest 300); the footer says how many are shown, loaded and in total. ROI is shown per trade; it is never averaged. */
MON.cf = MON.cf || { analyst: "", coin: "", dir: "", reason: "", data: "", from: "", to: "" };
function mHist(ms) { return mDur(ms); }
function renderMonitorClosed() {
  if (!$("mClosed")) return; var C = MON.closed || [], F = MON.cf;
  if (!C.length) { $("mClosed").textContent = "No closed paper positions in this ledger."; return; }
  var reasons = Array.from(new Set(C.map(function (p) { return p.closed.reason; }))).sort();
  var sel = function (id, label, opts, cur) { return '<label class="sub" for="' + id + '">' + label + '</label> <select id="' + id + '" style="width:auto"><option value="">all</option>' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select> "; };
  var fromMs = F.from ? Date.parse(F.from + "T00:00:00Z") - TZ.ms : null, toMs = F.to ? Date.parse(F.to + "T23:59:59Z") - TZ.ms : null;
  var L = C.filter(function (p) { var c = p.closed; return (!F.analyst || p.analyst === F.analyst) && (!F.coin || p.symbol === F.coin) && (!F.dir || p.direction === F.dir) && (!F.reason || c.reason === F.reason) && (!F.data || (F.data === "uncertain" ? !c.evaluable : c.evaluable)) && (fromMs === null || c.exit_ts >= fromMs) && (toMs === null || c.exit_ts <= toMs); });
  var env = (MON.val || MON.snap || {}).environment || "";
  var bar = '<div id="mClosedFilters" class="bar2" style="margin-bottom:8px"><span class="pill">' + esc(env || "this worker") + " ledger only</span> " +
    sel("hfAnalyst", "Account", Object.keys(M_AN).map(function (k) { return [k, M_AN[k]]; }), F.analyst) + sel("hfCoin", "Asset", Array.from(new Set(C.map(function (p) { return p.symbol; }))).sort().map(function (x) { return [x, x]; }), F.coin) +
    sel("hfDir", "Direction", [["LONG", "LONG"], ["SHORT", "SHORT"]], F.dir) + sel("hfReason", "Exit", reasons.map(function (x) { return [x, x]; }), F.reason) + sel("hfData", "Data", [["evaluable", "evaluable"], ["uncertain", "uncertain (data gap)"]], F.data) +
    '<label class="sub" for="hfFrom">From</label> <input type="date" id="hfFrom" value="' + esc(F.from) + '" style="width:auto"> <label class="sub" for="hfTo">to</label> <input type="date" id="hfTo" value="' + esc(F.to) + '" style="width:auto"> <button id="hfClear" style="padding:2px 10px">Clear filters</button></div>';
  var net = L.reduce(function (a, p) { return a + p.closed.net_usdt; }, 0), gross = L.reduce(function (a, p) { return a + p.closed.gross_usdt; }, 0), fees = L.reduce(function (a, p) { return a + p.fees_paid; }, 0), fund = L.reduce(function (a, p) { return a + p.funding_settled; }, 0);
  var rows = L.map(function (p) {
    var d = mDp(p.entry_fill_price), c = p.closed, sg = c.signal;
    return '<tr class="mrow" tabindex="0" data-pid="' + esc(p.position_id) + '"><td>' + istT(c.exit_ts) + '<br><span class="sub">held ' + mHist(c.holding_ms) + "</span></td><td><b>" + esc(M_AN[p.analyst] || p.analyst) + '</b><br><span class="sub">' + esc(p.strategy_version || "") + "</span></td><td>" + esc(p.symbol) + '</td><td class="' + (p.side > 0 ? "up" : "down") + '">' + esc(p.direction) + "</td>" +
      '<td class="num">' + (c.initial_margin === null ? "N/A" : mNum(c.initial_margin, 2)) + '<br><span class="sub">' + esc(String(c.margin_setting_leverage)) + "× setting</span></td>" +
      '<td class="num">' + mNum(p.entry_fill_price, d) + " → " + mNum(c.exit_price, d) + '</td><td class="sub">' + esc(sg ? sg.code : "") + "</td><td>" + esc(c.reason) + '</td><td class="num">' + mSigned(c.gross_usdt, 4) + '</td><td class="num">−' + mNum(p.fees_paid, 4) + '</td><td class="num">' + mSigned(p.funding_settled, 4) +
      '</td><td class="num"><b class="' + mCls(c.net_usdt) + '">' + mSigned(c.net_usdt, 4) + '</b></td><td class="num" title="' + esc(c.roi_basis) + '">' + (c.net_return_on_initial_margin_pct === null ? "N/A" : mSigned(c.net_return_on_initial_margin_pct, 2) + "%") + '<br><span class="sub">net ÷ initial margin</span></td><td>' +
      (c.evaluable ? "evaluable" : '<span class="warn">UNCERTAIN (data gap): in the account, excluded from win/expectancy metrics</span>') + "</td></tr>";
  }).join("");
  $("mClosed").innerHTML = bar + (L.length ? '<table id="mClosedTable"><tr><th>Closed (' + TZ.label + ')</th><th>Account · strategy</th><th>Asset</th><th>Side</th><th class="r">Initial margin (USDT)</th><th class="r">Entry → exit</th><th>Signal</th><th>Exit</th><th class="r">Gross</th><th class="r">Fees</th><th class="r">Funding</th><th class="r">Net</th><th class="r">ROI (per trade)</th><th>Metric eligibility</th></tr>' + rows + "</table>" : "<div>No closed position matches these filters.</div>") +
    '<div class="sub" style="margin-top:6px" id="mClosedFoot">Showing ' + L.length + " of " + C.length + " loaded closed positions" + (MON.closedTotal !== undefined ? " (" + MON.closedTotal + " closed in this ledger)" : "") + ". Selection totals (sums, not averages): gross " + mSigned(gross, 4) + " · fees −" + mNum(fees, 4) + " · funding " + mSigned(fund, 4) + " · net " + mSigned(net, 4) + " USDT. ROI is per trade and is never averaged into an account return. Amounts are USDT-margined simulated results, not exact USD.</div>";
  var bind = function (id, key) { var e = $(id); if (e) e.onchange = function () { MON.cf[key] = e.value; renderMonitorClosed(); }; };
  bind("hfAnalyst", "analyst"); bind("hfCoin", "coin"); bind("hfDir", "dir"); bind("hfReason", "reason"); bind("hfData", "data"); bind("hfFrom", "from"); bind("hfTo", "to");
  var clr = $("hfClear"); if (clr) clr.onclick = function () { MON.cf = { analyst: "", coin: "", dir: "", reason: "", data: "", from: "", to: "" }; renderMonitorClosed(); };
  $("mClosed").querySelectorAll(".mrow").forEach(function (r) { r.onclick = function () { monitorOpenDetail(r.dataset.pid); }; r.onkeydown = function (e) { if (e.key === "Enter") monitorOpenDetail(r.dataset.pid); }; });
}
function renderMonitorRegistry() {
  if (!$("mRegistry") || !MON.registry) return; var R = MON.registry, J = MON.jobs || {};
  $("mRegistry").innerHTML = "<table><tr><th>ID · version</th><th>Type</th><th>Training</th><th>Validation evidence</th><th>Edge</th><th>State</th><th>Known weaknesses</th></tr>" + R.strategies.map(function (s) {
    return "<tr><td><b>" + esc(s.name) + "</b><br><span class=\"sub\">" + esc(s.version) + " · features " + esc(s.feature_schema) + "</span></td><td>" + esc(s.type) + "</td><td>" + esc(s.training.replace(/_/g, " ")) + "</td><td class=\"sub\">" + esc(s.validation) + "</td><td><b>" + esc(s.edge.replace(/_/g, " ")) + "</b></td><td>" + esc(s.deployment_state.replace(/_/g, " ")) + '</td><td class="sub">' + esc(s.known_weaknesses.join("; ")) + "</td></tr>";
  }).join("") + "</table>" + '<div style="margin-top:8px">' + esc(R.model_note) + " Legacy: " + esc(R.legacy.map(function (l) { return l.id + " (" + l.state + ", " + l.calibration + ")"; }).join("; ")) + ".</div>" +
    '<div style="margin-top:6px"><b>Research / training jobs:</b> ' + esc(J.training_backend === "UNAVAILABLE" ? "Training backend unavailable." : String(J.training_backend || "unknown")) + " " + esc(J.note || "") + "</div>" + monitorLabHtml(R.research, J);
}
function monitorLabHtml(L, J) {
  if (!L) return "";
  var F = L.final, V = L.validation, crit = F && F.criteria ? Object.keys(F.criteria).sort() : [], num = function (v, d) { return v === null || v === undefined || !isFinite(v) ? "n/a" : Number(v).toFixed(d); };
  var cls = /^CANDIDATE/.test(L.state) ? "warnc" : /^REJECTED|UNREADABLE/.test(L.state) ? "bad" : "";
  var h = '<div class="chip ' + cls + '" style="margin-top:10px;max-width:none"><b>Model Lab · ' + esc(L.preregistration) + " (research only)</b><div><span class=\"pill\">" + esc(L.state.replace(/_/g, " ")) + "</span> " + esc(L.headline) + "</div>";
  h += '<div class="sub">Logged trials: ' + esc(L.trials.count) + " of " + esc(L.trials.cap) + " allowed" + (Object.keys(L.trials.by_family).length ? " (" + esc(Object.keys(L.trials.by_family).map(function (k) { return k + " " + L.trials.by_family[k]; }).join(", ")) + ")" : "") + ". Nothing here is promoted, places a trade or changes a policy.</div>";
  if (V) h += '<div class="sub">Validation: base-rate log loss ' + esc(num(V.base_logloss, 4)) + (V.selected ? "; selected " + esc(V.selected.family) + " at threshold " + esc(V.selected.theta) + " (validation mean " + esc(num(V.selected.val_mean_R, 3)) + " R per trade, " + esc(V.selected.val_trades) + " trades)" : "; nothing selected") + (V.reason ? ". " + esc(V.reason) : "") + "</div>";
  if (F) h += '<div class="sub">Final segment (scored once): ' + esc(F.trades) + " trades, mean " + esc(num(F.mean_R, 3)) + " R per trade" + (F.ci ? ", 95% CI [" + esc(num(F.ci.lo, 3)) + ", " + esc(num(F.ci.hi, 3)) + "]" : "") + (F.random_matched ? "; random entries with the same trade count: 95th percentile " + esc(num(F.random_matched.p95, 3)) : "") + ".<ul style=\"margin:2px 0 0;padding-left:18px\">" + crit.map(function (k) { return "<li>" + (F.criteria[k] ? "met" : "NOT met") + " · " + esc(k.replace(/^\d_/, "").replace(/_/g, " ")) + "</li>"; }).join("") + "</ul></div>";
  if (L.loop) h += '<div class="sub">Local loop: ' + esc(L.loop.state || "unknown") + ", last tick " + esc(L.loop.last_tick_utc || "never") + ", last outcome " + esc(L.loop.last_outcome || "none") + ".</div>";
  return h + "</div>";
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
  monitorTimeline(D);
  $("mDetailCard").scrollIntoView({ block: "nearest" });
}
/* P&L / ROI timeline: only what the monitor RECORDED once a minute while the position was open. Gaps are left empty, never interpolated or reconstructed. */
function monitorTimeline(D) {
  var T = D.timeline, p = D.position, el = $("mTimeline"), note = $("mTimelineNote"); if (!el) return;
  if (!T || !T.samples.length) { el.classList.add("hidden"); note.innerHTML = "<b>Valuation timeline:</b> " + esc(T && T.note ? T.note : "not available") + " Nothing is reconstructed for earlier times."; return; }
  el.classList.remove("hidden");
  if (!MON.tl) { MON.tl = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: "#171a21" }, textColor: "#8b93a3" }, grid: { vertLines: { color: "#1f232c" }, horzLines: { color: "#1f232c" } }, timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#262b35" }, rightPriceScale: { borderColor: "#262b35" } });
    MON.tlG = MON.tl.addLineSeries({ color: "#6ea8fe", lineWidth: 2, title: "gross P&L" }); MON.tlN = MON.tl.addLineSeries({ color: "#f5a524", lineWidth: 2, title: "net if closed (est.)" }); }
  var tm = function (t) { return (t + TZ.ms) / 1000; }, g = [], n = [], prev = null;
  T.samples.forEach(function (r) { if (prev !== null && r.ts - prev > 150000) { g.push({ time: tm(prev + 60000) }); n.push({ time: tm(prev + 60000) }); }        // a gap stays EMPTY
    if (r.gross_unrealized !== null) g.push({ time: tm(r.ts), value: r.gross_unrealized }); if (r.net_if_closed !== null) n.push({ time: tm(r.ts), value: r.net_if_closed }); prev = r.ts; });
  MON.tlG.setData(g); MON.tlN.setData(n); MON.tl.timeScale().fitContent();
  var c = T.coverage; note.innerHTML = "<b>Valuation timeline (recorded, not reconstructed):</b> " + c.count + " one-minute samples from " + istT(c.first_ts) + " to " + istT(c.last_ts) + " " + TZ.label + " · " + (c.gaps.length ? c.gaps.length + " gap(s) left empty (" + c.gaps.map(function (x) { return mDur(x.ms); }).join(", ") + ")" : "no gaps") +
    " · blue: gross P&L at mark, amber: estimated net if closed at that time · recording on this worker began " + istT(T.recording_since_ts) + (p.closed ? " · final booked net " + mSigned(p.closed.net_usdt, 4) + " USDT at exit" : "") + ".";
}
document.addEventListener("DOMContentLoaded", function () {
  $("mDetailClose").onclick = function () { MON.detailId = null; $("mDetailCard").classList.add("hidden"); };
  ["mFType", "mFAnalyst", "mFCoin"].forEach(function (k) { $(k).onchange = renderMonitorActivity; });
});
