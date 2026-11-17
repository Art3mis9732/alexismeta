"use strict";
/* Browser verification of the live paper monitor. NOT part of `npm test` (needs Playwright, Chromium and Bitget access).
 *
 *   node tests_e2e/monitor.e2e.js <forward-worker-url> <static-url> [screenshotDir]
 *   e.g. node tests_e2e/monitor.e2e.js http://127.0.0.1:8787/ http://127.0.0.1:8788/ shots
 *
 * The script starts ITS OWN TEST-environment worker (--env test --fixture, separate database in the OS temp folder) so
 * that it can stop and restart it. It never writes to the forward ledger.
 * Step 0 asserts every worker it talks to serves exactly the working tree (source fingerprint) - a stale worker fails
 * the run instead of producing misleading results. */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { sourceFingerprint } = require("../server/runtime");

const ROOT = path.resolve(__dirname, ".."), TEST_PORT = 8792;
const [forwardUrl, staticUrl, shots] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 260) : ""}`); };
const getJson = url => new Promise((res, rej) => http.get(url, r => { let s = ""; r.on("data", d => s += d); r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on("error", rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the TEST worker reads its research registry from a fixture directory (a rejected research run), never from the repository's real one
const LAB_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "e2e-lab-"));
fs.writeFileSync(path.join(LAB_DIR, "trials.jsonl"), [1, 2, 3].map(i => JSON.stringify({ trial_id: i, kind: "config", family: i === 1 ? "constant" : "lr" })).join("\n") + "\n");
fs.writeFileSync(path.join(LAB_DIR, "validation_result.json"), JSON.stringify({ val_base_logloss: 0.6543, selected: null, reason: "REJECTED_ON_VALIDATION: no configuration beat the base rate", n_config_trials: 3 }));
fs.writeFileSync(path.join(LAB_DIR, "loop_state.json"), JSON.stringify({ state: "IDLE", last_tick_utc: "2026-11-17T00:00:00Z", last_outcome: "SKIPPED_STRESS" }));
function startTestWorker(db) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "server", "main.js"), "--port", String(TEST_PORT), "--env", "test", "--fixture", "--stress-fixture", "--db", db], { cwd: ROOT, env: { ...process.env, ALEXIS_LAB_DIR: LAB_DIR }, stdio: "ignore" });
  return p;
}
async function waitFor(fn, ms, step = 500) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ } if (Date.now() > end) return null; await sleep(step); } }
const stop = p => new Promise(res => { if (!p || p.exitCode !== null) return res(); p.once("exit", res); p.kill("SIGINT"); setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) { /* gone */ } }, 5000); });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexismeta-e2e-")), db = path.join(dir, "test-fixture.db"), testUrl = `http://127.0.0.1:${TEST_PORT}/`;
  let worker = startTestWorker(db);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
  const browser = await chromium.launch({ proxy });
  try {
    // ---------- 0. build identity
    const fp = sourceFingerprint();
    const rtT = await waitFor(() => getJson(testUrl + "api/runtime"), 30000), rtF = await getJson(forwardUrl + "api/runtime");
    check("0. TEST worker serves this working tree and is the TEST environment", rtT && rtT.build.source_fingerprint === fp && rtT.database.environment === "TEST", rtT && `${rtT.build.revision}${rtT.build.dirty ? "+dirty" : ""} fp ${rtT.build.source_fingerprint} vs tree ${fp}`);
    // The forward worker is NEVER restarted just to refresh a build while it holds open paper positions (each restart is a data gap
    // that marks them unresolved). If it serves an older build, forward-only checks are skipped and reported, not silently passed.
    const fwdFresh = rtF.build.source_fingerprint === fp && rtF.database.environment === "FORWARD";
    if (fwdFresh) check("0. forward worker serves this working tree and is the FORWARD environment", true, `${rtF.build.revision} fp ${rtF.build.source_fingerprint}; instance ${rtF.instance_id.slice(0, 8)}`);
    else console.log(`SKIP  forward-environment checks: the forward worker serves fp ${rtF.build.source_fingerprint}, the working tree is ${fp} (env ${rtF.database.environment}); restart it only when it has no open positions. News checks run on the TEST worker instead.`);
    check("0. the two workers are different instances with different ledger databases", rtT.instance_id !== rtF.instance_id && rtT.database.db_id !== rtF.database.db_id, "");
    const newsUrl = fwdFresh ? forwardUrl : testUrl;
    if (results.some(r => !r.ok)) throw new Error("stale or wrong worker: refusing to continue");

    // ---------- 1. TEST environment: positions, valuation, detail, activity
    const snap = await waitFor(async () => { const s = await getJson(testUrl + "api/paper/snapshot"); return s.positions.length >= 2 ? s : null; }, 60000, 1000);
    check("1. TEST fixture opened paper positions through the unchanged risk gate and engine", !!snap, snap ? `${snap.positions.length} open` : "none within 60 s");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await ctx.newPage(), errors = [], sockets = [];
    page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("websocket", ws => sockets.push(ws.url()));
    await page.goto(testUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#mPositions .mrow").length > 0 && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    check("1. the monitor is the first view when the page is served by a worker", await page.locator("#monitorView").isVisible() && (await page.locator('#views span.on').innerText()) === "Paper monitor", "");
    check("1. persistent PAPER / SIMULATED label and TEST banner", /PAPER · SIMULATED EXECUTION/.test(await page.locator(".paperbar").innerText()) && /TEST ENVIRONMENT/.test(await page.locator("#mTest").innerText()), "");
    await page.waitForFunction(() => /● STREAMING/.test(document.getElementById("mStatus").innerText) && /● HEALTHY/.test(document.getElementById("mStatus").innerText), null, { timeout: 15000 }).catch(() => {});
    const chips = await page.locator("#mStatus .chip").allInnerTexts();
    check("1. five separate status chips with text states (not colour only)", chips.length === 5 && ["MARKET FEED", "DECISION ENGINE", "PAPER ENGINE", "BROWSER CONNECTION", "POSITION VALUATION"].every((t, i) => chips[i].toUpperCase().includes(t)) && chips.every(c => /HEALTHY|RUNNING|STREAMING|LIVE|DEGRADED|STALE/.test(c)), chips.map(c => c.replace(/\n/g, " ").slice(0, 46)).join(" | "));
    const cmp = await page.evaluate(() => { const p = MON.val.positions[0], row = document.querySelector('#mPositions .mrow[data-pid="' + p.position_id + '"]'); const f = k => row.querySelector('[data-f="' + k + '"]').innerText;
      return { shown: f("gross"), backend: p.valuation.u_mark, life: f("net"), lifeB: p.valuation.lifecycle_if_closed_now, mark: f("mark"), markB: p.live.prices.mark, margin: f("margin"), marginB: p.live.margin.allocated_now }; });
    const fmt = x => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    check("1. displayed unrealised and close-now figures are the backend's numbers (the browser does not recompute)", cmp.shown.startsWith(fmt(cmp.backend)) && cmp.life.startsWith(fmt(cmp.lifeB)) && cmp.backend !== cmp.lifeB && cmp.margin.startsWith(cmp.marginB.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })), `${cmp.shown} / ${cmp.life} / margin ${cmp.margin}`);
    check("1. worker-mode page opened no exchange socket of its own", sockets.filter(u => /bitget/.test(u)).length === 0, sockets.join(","));
    const a1 = await page.locator("#mAccounts").innerText();
    check("1. three independent accounts, never summed", (a1.match(/Starting capital/g) || []).length === 3 && /3 independent paper portfolios of 1000 USDT each \(total starting capital 3000 USDT\)/.test(a1) && (a1.match(/reconciles with fills/g) || []).length === 3, "");
    const v1 = await page.evaluate(() => MON.val.calc_ts); await sleep(2500); const v2 = await page.evaluate(() => MON.val.calc_ts);
    const lat = await page.evaluate(() => Date.now() - MON.val.calc_ts);
    check("1. valuations keep arriving from the backend stream", v2 > v1, `frame age at read ${lat} ms`);
    await page.locator("#mPositions .mrow").first().focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("mDetailCard").classList.contains("hidden") && /Fills/.test(document.getElementById("mDetail").innerText), null, { timeout: 10000 }).catch(() => {});
    const det = await page.locator("#mDetail").innerText();
    check("1. position detail (keyboard: focus row + Enter): decision, evidence, risk history, fills, funding, gaps, chart", /Decision/.test(det) && /Supporting observations/.test(det) && /RISK_APPROVED/.test(det) && /ENTRY/.test(det) && /Funding postings/.test(det) && /Data gaps while open/.test(det) && /TEST FIXTURE/i.test(det) && await page.locator("#mChart canvas").count() > 0, "");
    if (shots) await page.screenshot({ path: path.join(shots, "monitor-test-desktop.png"), fullPage: true });
    await page.locator("#mDetailClose").click();
    await page.selectOption("#mFType", "FILL");
    const types = await page.locator("#mActivity table tr td:nth-child(4)").allInnerTexts();
    check("1. activity timeline lists durable events and filters by type", types.length > 0 && types.every(t => t === "FILL"), `${types.length} FILL rows`);
    await page.selectOption("#mFType", "");
    const reg = await page.locator("#mRegistry").innerText();
    check("1. registry labels analysts DETERMINISTIC / training NOT APPLICABLE / edge NOT DEMONSTRATED; Model Lab shows a REJECTED research run read-only, nothing promoted", (reg.match(/DETERMINISTIC/g) || []).length >= 3 && /NOT APPLICABLE/.test(reg) && /NOT DEMONSTRATED/.test(reg) && /Model Lab/i.test(reg) && /REJECTED ON VALIDATION/.test(reg) && /Logged trials: 3 of 40/.test(reg) && /SKIPPED_STRESS/.test(reg) && /places a trade or changes a policy/.test(reg) && !/promoted: true/.test(reg), "");

    // ---------- 1b. news SHADOW overlay: recorded for candidate entries, never an input to a decision, visible on the News tab
    const shadowApi = await getJson(testUrl + "api/news/shadow?limit=20");
    check("1b. news shadow API: mode SHADOW, effect on decisions NONE, one record per candidate entry with a verdict", shadowApi.mode === "SHADOW" && shadowApi.effect_on_decisions === "NONE" && shadowApi.rows.length >= 1 && shadowApi.rows.every(r => r.verdict && r.assessment.effect_on_decision === "NONE (shadow only)"), `${shadowApi.rows.length} rows`);
    await page.click('#views span[data-view="news"]'); await page.waitForTimeout(1500);
    const shTxt = await page.locator("#nShadow").innerText();
    check("1b. News tab shows the shadow card: SHADOW, effect NONE, each candidate with analyst, verdict and the gate/paper result", /SHADOW/i.test(shTxt) && /NONE/.test(shTxt) && /risk taker|balanced|defensive/i.test(shTxt) && /LONG|SHORT/.test(shTxt), shTxt.slice(0, 120));
    await page.click('#views span[data-view="monitor"]'); await page.waitForTimeout(500);

    // ---------- 2. refresh and stream reconnect never create or duplicate anything
    const before = await getJson(testUrl + "api/paper/snapshot");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => MON.snap && MON.conn === "STREAMING", null, { timeout: 20000 }).catch(() => {});
    const dupe = await page.evaluate(() => { const s = MON.events.map(e => e.seq); return { n: s.length, unique: new Set(s).size, cursor: MON.cursor }; });
    const after = await getJson(testUrl + "api/paper/snapshot");
    const fillsOf = s => s.recent_activity.filter(e => e.type === "FILL" && e.payload.kind === "ENTRY").length;
    check("2. a browser refresh shows the same account and creates no trade", fillsOf(after) >= fillsOf(before) && after.db_id === before.db_id && dupe.n === dupe.unique, `events ${dupe.n}, unique ${dupe.unique}, cursor ${dupe.cursor}`);

    // ---------- 3. worker loss: frozen, labelled, never LIVE; then recovery from a backend snapshot
    await page.waitForFunction(() => document.querySelectorAll("#mPositions .mrow").length > 0 || /No open paper positions/.test(document.getElementById("mPositions").innerText), null, { timeout: 15000 }).catch(() => {});
    const openBefore = await getJson(testUrl + "api/paper/snapshot"), factsBefore = openBefore.positions.map(p => p.position_id).sort().join(",");
    const frozenText0 = await page.locator("#mAccounts").innerText();
    await stop(worker);
    await page.waitForFunction(() => /DISCONNECTED/.test(document.getElementById("mStatus").innerText) && /FROZEN/.test(document.getElementById("mStatus").innerText), null, { timeout: 25000 }).catch(() => {});
    const lostChips = await page.locator("#mStatus").innerText(), mode = await page.locator("#mode").innerText();
    check("3. worker stopped: engine chips say DISCONNECTED and valuation says FROZEN with its last timestamp", /Paper engine\s*○ DISCONNECTED/i.test(lostChips.replace(/\n/g, " ")) && /FROZEN/.test(lostChips) && /not updated since/.test(lostChips), lostChips.replace(/\n/g, " ").slice(0, 200));
    check("3. the page header does not claim the platform is live", /WORKER DISCONNECTED/.test(mode) && /not live/.test(mode) && !/● LIVE/.test(mode), mode);
    const sb = (await page.locator("#stressBar").innerText()).replace(/\n/g, " ");
    check("3. worker stopped: the market-stress strip says WORKER DISCONNECTED and not updating (it does not keep claiming a live state)", /WORKER DISCONNECTED: not updating/.test(sb) && /MARKET STRESS/.test(sb), sb.slice(0, 160));
    const f1 = await page.locator("#mAccounts").innerText(); await sleep(4000); const f2 = await page.locator("#mAccounts").innerText();
    check("3. account figures stay frozen: fallback browser prices do not revalue positions or accounts", f1 === f2 && await page.locator("#mAccounts .frozen").count() > 0, "");
    if (shots) await page.screenshot({ path: path.join(shots, "monitor-worker-lost.png"), fullPage: false });
    worker = startTestWorker(db);
    const rt2 = await waitFor(() => getJson(testUrl + "api/runtime"), 30000);
    await page.waitForFunction(() => MON.conn === "STREAMING" && !MON.lost && /● RUNNING/.test(document.getElementById("mStatus").innerText), null, { timeout: 40000 }).catch(() => {});
    const rec = await page.evaluate(() => ({ why: MON.lastResnapshot, inst: MON.runtime.instance_id, chips: document.getElementById("mStatus").innerText, mode: document.getElementById("mode").innerText }));
    const openAfter = await getJson(testUrl + "api/paper/snapshot"), factsAfter = openAfter.positions.map(p => p.position_id).sort().join(",");
    check("3. worker restarted: the page reconciles from a new backend snapshot (new instance id) and returns to live", rt2 && rec.inst === rt2.instance_id && rt2.instance_id !== rtT.instance_id && /worker recovered|instance or database changed/.test(rec.why || "") && /via local worker/.test(rec.mode), `${rec.why}; ${rec.mode.slice(0, 50)}`);
    const stillOpen = factsBefore.split(",").filter(Boolean).filter(id => factsAfter.includes(id) || openAfter.recent_closed.some(c => c.position_id === id));
    check("3. positions open before the restart are all still accounted for afterwards (open or closed), same database, accounts reconcile", stillOpen.length === factsBefore.split(",").filter(Boolean).length && openAfter.db_id === openBefore.db_id && openAfter.accounts.every(a => a.cash_reconciles), `${stillOpen.length} positions tracked`);
    const entryFills = openAfter.recent_activity.filter(e => e.type === "FILL").map(e => e.key);
    check("3. no fill was duplicated by the restart", entryFills.length === new Set(entryFills).size, `${entryFills.length} fills`);
    check("1-3. no page errors in the TEST session", errors.length === 0, errors.join(" | "));
    await ctx.close();

    // ---------- 4. forward environment: real state only
    if (fwdFresh) {
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), p2 = await c2.newPage(), e2 = [];
    p2.on("pageerror", e => e2.push(e.message));
    await p2.goto(forwardUrl, { waitUntil: "domcontentloaded" });
    await p2.waitForFunction(() => MON.snap && MON.diag && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    const fs1 = await getJson(forwardUrl + "api/paper/snapshot"), posText = await p2.locator("#mPositions").innerText();
    check("4. forward monitor shows exactly the ledger's positions (none fabricated) and no TEST banner", (fs1.positions.length === 0 ? /No open paper positions/.test(posText) : (await p2.locator("#mPositions .mrow").count()) === fs1.positions.length) && (await p2.locator("#mTest").innerText()) === "" && fs1.environment === "FORWARD", `${fs1.positions.length} open in the forward ledger`);
    const diag = await p2.locator("#mDiag").innerText();
    check("4. last decisions are explained predicate by predicate", /met/.test(diag) && /(Blocked by:|All entry conditions met)/.test(diag) && /warm-up/.test(diag), diag.replace(/\n/g, " ").slice(0, 160));
    for (const s of ["ETHUSDT", "XRPUSDT"]) await p2.locator(`#coins span[data-sym="${s}"]`).click();
    await p2.selectOption("#tzSel", "UTC"); await sleep(800);
    check("4. switching coin and timezone re-renders the monitor without errors", /XRP perpetual/i.test(await p2.locator("#mDiagSym").innerText()) && /UTC/.test(await p2.locator("#mStatus").innerText()) && e2.length === 0, e2.join("|"));
    await p2.selectOption("#tzSel", "IST");
    for (const v of ["trade", "patterns", "indicators", "monitor"]) { await p2.locator(`#views span[data-view="${v}"]`).focus(); await p2.keyboard.press("Enter"); await sleep(300); }
    check("4. keyboard navigation between all four views works and the older views still render", await p2.locator("#monitorView").isVisible() && e2.length === 0, "");
    if (shots) await p2.screenshot({ path: path.join(shots, "monitor-forward-desktop.png"), fullPage: true });
    await c2.close();
    }

    // ---------- 4b. News tab (forward worker): reachable from the default load, honest about sources, relevance and interpretation
    const pn = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(), en = [];
    pn.on("pageerror", e => en.push(e.message));
    await pn.goto(newsUrl, { waitUntil: "domcontentloaded" });
    await pn.waitForFunction(() => window.MON && MON.snap, null, { timeout: 30000 }).catch(() => {});
    check("4b. the News tab is in the header and reachable from the default (Paper monitor) load", await pn.locator('#views span[data-view="news"]').count() === 1, "");
    await pn.locator('#views span[data-view="news"]').focus(); await pn.keyboard.press("Enter");
    await pn.waitForFunction(() => /sources healthy/.test(document.getElementById("nSummary").innerText) && document.querySelectorAll("#nSources tr").length > 1, null, { timeout: 30000 }).catch(() => {});
    await pn.locator("#nSrcSum").click();   // the source table is collapsed by default (articles come first); expand it as a user would
    const apiNews = await getJson(newsUrl + "api/news?limit=80"), summary = await pn.locator("#nSummary").innerText(), rows = await pn.locator("#nSources table tr").count();
    check("4b. source health table has one row per source, with text status and separate fetch vs newest-item clocks", rows === apiNews.sources.length + 1 && /Fetched/.test(await pn.locator("#nSources").innerText()) && /Newest item/.test(await pn.locator("#nSources").innerText()) && /sources healthy/.test(summary), summary.slice(0, 160));
    check("4b. the summary counts agree with the API (relevant vs hidden), not a hard-coded list", summary.includes(String(apiNews.counts.total) + " items stored") && summary.includes(String(apiNews.counts.hidden_not_relevant) + " not related"), `${apiNews.counts.total} total / ${apiNews.counts.relevant} relevant`);
    const shown = await pn.locator("#nItems .pf").count();
    check("4b. relevant-only by default; 'include unrelated' reveals the rest", shown === apiNews.items.length, `${shown} shown`);
    await pn.locator("#nAll").check(); await pn.waitForFunction(n => document.querySelectorAll("#nItems .pf").length > n, shown, { timeout: 15000 }).catch(() => {});
    const allShown = await pn.locator("#nItems .pf").count();
    check("4b. including unrelated items shows more items (filters apply before the limit)", allShown > shown, `${shown} -> ${allShown}`);
    const txt = await pn.locator("#nItems").innerText();
    check("4b. no item claims a probability or 'priced in'; interpretations say they are potential and unevaluated", !/\d+(\.\d+)?\s*%\s*(chance|probability|confidence)/i.test(txt) && !/already priced in|is priced in/i.test(txt.replace(/“already priced in” is not assessed/g, "")), "");
    await pn.locator("#nAsset").selectOption("XRP"); await sleep(1500);
    check("4b. asset filter works and macro/venue items are still included", await pn.locator("#nAsset").inputValue() === "XRP" && en.length === 0, en.join("|"));
    await pn.screenshot({ path: shots ? path.join(shots, "news-tab.png") : undefined, fullPage: false }).catch(() => {});
    await pn.context().close();

    // ---------- 4c. layout defects that only a rendered page shows (found by looking at screenshots, session 5)
    const c4 = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), p4 = await c4.newPage(), e4 = [];
    p4.on("pageerror", e => e4.push(e.message));
    await p4.goto(testUrl, { waitUntil: "domcontentloaded" });
    await p4.waitForFunction(() => MON.snap && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    const acc = await p4.evaluate(() => { const box = document.querySelector("#mAccounts").getBoundingClientRect(), cards = [...document.querySelectorAll("#mAccounts .profiles > *")].map(c => c.getBoundingClientRect());
      return { n: cards.length, inside: cards.every(r => r.left >= box.left - 1 && r.right <= box.right + 1), widths: cards.map(r => Math.round(r.width)) }; });
    check("4c. desktop: all three paper accounts fit inside their card (none clipped off to the right), TEST page with open positions", acc.n === 3 && acc.inside, JSON.stringify(acc));
    // The original defect appeared on the forward page (no open positions), where a long unbreakable row stretched one column; check there too.
    await p4.goto(forwardUrl, { waitUntil: "domcontentloaded" });
    await p4.waitForFunction(() => MON.snap && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    const accF = await p4.evaluate(() => { const box = document.querySelector("#mAccounts").getBoundingClientRect(), cards = [...document.querySelectorAll("#mAccounts .profiles > *")].map(c => c.getBoundingClientRect());
      return { n: cards.length, inside: cards.every(r => r.left >= box.left - 1 && r.right <= box.right + 1), widths: cards.map(r => Math.round(r.width)) }; });
    check("4c. desktop: all three paper accounts fit inside their card, forward page", accF.n === 3 && accF.inside, JSON.stringify(accF));
    await p4.click('#views span[data-view="news"]'); await p4.waitForTimeout(1500);
    const order = await p4.evaluate(() => ({ items: document.querySelector("#nItems").getBoundingClientRect().top, health: document.querySelector("#nSrcBox").getBoundingClientRect().top, openHealth: document.querySelector("#nSrcBox").open, sum: document.querySelector("#nSrcSum").innerText }));
    check("4c. News: the articles come before the source-health table, which is collapsed with a one-line verdict", order.items < order.health && /sources? (OK|need attention)/.test(order.sum), `items at ${Math.round(order.items)}px, health at ${Math.round(order.health)}px; ${order.sum.slice(0, 80)}`);
    await p4.click('#views span[data-view="patterns"]'); await p4.waitForTimeout(1500);
    const rng = await p4.evaluate(() => { const r = CH.p.ch.timeScale().getVisibleLogicalRange(); return { span: r ? r.to - r.from : null, w: document.querySelector("#chart").clientWidth }; });
    check("4c. Patterns: the chart shows the intended ~128-candle window after the tab is opened (not hundreds squeezed to one side)", rng.span !== null && rng.span > 100 && rng.span < 150 && rng.w > 300, JSON.stringify(rng));
    check("4c. no page errors while visiting every tab", e4.length === 0, e4.join("|"));
    await c4.close();

    // ---------- 4d. market stress (SYNTHETIC scripted BTC scenario on the TEST worker; ETH/XRP are real): every state is looked at in the browser
    {
      const c5 = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), p5 = await c5.newPage(), e5 = [];
      p5.on("pageerror", e => e5.push(e.message)); p5.on("console", m => { if (m.type() === "error") e5.push("console " + m.text()); }); p5.on("response", r => { if (r.status() >= 400) e5.push(r.status() + " " + r.url()); });
      await p5.goto(testUrl, { waitUntil: "domcontentloaded" });
      await p5.waitForFunction(() => window.STRESS && STRESS.data, null, { timeout: 30000 }).catch(() => {});
      const apiS = () => getJson(testUrl + "api/stress"), btc = d => d.instruments.find(i => i.symbol === "BTC");
      for (const v of ["monitor", "news", "trade", "patterns", "indicators", "stress"]) { await p5.click(`#views span[data-view="${v}"]`); await sleep(300);
        const vis = await p5.locator("#stressBar").isVisible(), txt = await p5.locator("#stressBar").innerText();
        check(`4d. the market-stress summary is visible on the ${v} tab`, vis && /MARKET STRESS/.test(txt) && /BTC/.test(txt) && /ETH/.test(txt) && /XRP/.test(txt), txt.replace(/\n/g, " ").slice(0, 90)); }
      const word = { CRITICAL: "CRITICAL", HIGH_STRESS: "HIGH STRESS", ELEVATED: "ELEVATED", NORMAL: "NORMAL" };
      const agree = async () => { for (let k = 0; k < 6; k++) { const a = await apiS(), t = await p5.locator("#stressBar").innerText(), a2 = await apiS(); if (JSON.stringify(a.instruments.map(i => [i.severity, i.quality])) !== JSON.stringify(a2.instruments.map(i => [i.severity, i.quality]))) { await sleep(1200); continue; }
        await sleep(5600); const t2 = await p5.locator("#stressBar").innerText(), b = await apiS();
        if (JSON.stringify(a2.instruments.map(i => [i.severity, i.quality])) !== JSON.stringify(b.instruments.map(i => [i.severity, i.quality]))) continue;
        return b.instruments.every(i => { const chip = new RegExp(i.symbol + "\\s+" + (i.quality === "UNRELIABLE" ? "○ DATA UNRELIABLE" : !i.severity_known ? "○ UNKNOWN" : "[^\\s]+ " + word[i.severity])); return chip.test(t2.replace(/\n/g, " ")); }); } return false; };
      check("4d. the strip agrees with /api/stress for every asset (severity and data quality)", await agree(), "");
      await p5.click('#views span[data-view="stress"]');
      const waitS = async (pred, ms) => waitFor(async () => { const d = await apiS(); return pred(btc(d)) ? d : null; }, ms, 1000);
      const dCrit = await waitS(i => i.severity === "CRITICAL" && i.quality === "VALID" && i.event, 280000);
      await sleep(5600);                                                          // the page polls every 5 s
      let card = await p5.locator("#sInst").innerText();
      check("4d. ACTIVE EVENT: BTC shows CRITICAL, the event id and onset, the measurements with their thresholds, and the risk verdict", !!dCrit && /BTC\s*■ CRITICAL/.test(card.replace(/\n/g, " ")) && /stress:bitget:perp:BTCUSDT:\d+/.test(card) && /Largest move vs normal noise/.test(card) && /≥ 8\.6 \/ ≥ 13\.9 \/ ≥ 19\.3/.test(card) && /would block new entries \(SHADOW: nothing is blocked\)/.test(card) && /stress-policy-v1/.test(card), card.slice(0, 90).replace(/\n/g, " "));
      check("4d. the page says SYNTHETIC, thresholds PROVISIONAL/fixture, and keeps observed / possible explanation / unverified hypotheses apart", /SYNTHETIC TEST SCENARIO/.test(await p5.locator("#sHead").innerText()) && /Observed \(measured/.test(card) && /Possible explanation \(news that coincides in time\)/.test(card) && /Unverified hypotheses/.test(card) && /None is asserted/.test(card), "");
      check("4d. the risk response says new entries only: open positions keep their stops, targets and accounting", /Stress can only block NEW entries\. Open positions keep their stops, targets and accounting\./.test(card) && /Risk Taker: would not be allowed to open new positions in BTC \(shadow\)/.test(card), "");
      const dUnr = await waitS(i => i.quality === "UNRELIABLE" && i.severity === "CRITICAL", 200000);
      await sleep(5600); card = await p5.locator("#sInst").innerText(); const strip = (await p5.locator("#stressBar").innerText()).replace(/\n/g, " ");
      check("4d. DATA UNRELIABLE during the event: shown as DATA UNRELIABLE, the last valid CRITICAL reading is retained with its time, no trend is claimed, measurements are marked possibly stale", !!dUnr && /BTC\s*○ DATA UNRELIABLE/.test(strip) && /last valid: CRITICAL at/.test(card) && !/IMPROVING|WORSENING/.test(card.split("ETH")[0]) && /Data unreliable: the figures below are the latest computed values and may be stale/.test(card), strip.slice(0, 120));
      const dOk = await waitS(i => i.severity === "NORMAL" && i.quality === "VALID" && !i.event, 280000);
      await sleep(5600); const ev = await p5.locator("#sEvents").innerText();
      check("4d. RECOVERY: after the dwell the event is closed as RECOVERED in the event history (and the earlier outage did not close it)", !!dOk && /RECOVERED/.test(ev) && !/UNOBSERVED/.test(ev.split("\n").slice(0, 8).join(" ")), ev.slice(0, 100).replace(/\n/g, " "));
      const apiEv = (await apiS()).events; check("4d. the API's event list and the page's event table have the same events", apiEv.length > 0 && (ev.match(/stress:bitget:perp:BTCUSDT:\d+/g) || []).length === apiEv.length, `${apiEv.length} events`);
      await p5.click('#views span[data-view="stress"]'); await p5.locator("#sPolDet summary").click(); const pol = await p5.locator("#sPolicy").innerText();
      check("4d. the policy table states what stops and what never stops, and the calibration is labelled", /never closes, reduces or re-prices an open position/.test(pol) && /Not implemented in v1: exposure reduction/.test(pol) && /Calibration basis/.test(pol), "");
      check("4d. no page errors, console errors or failed requests while visiting the stress tab through every state", e5.length === 0, e5.join(" | ").slice(0, 200));
      await c5.close();
      const c6 = await browser.newContext({ viewport: { width: 390, height: 844 } }), p6 = await c6.newPage(); await p6.goto(testUrl, { waitUntil: "domcontentloaded" });
      await p6.waitForFunction(() => window.STRESS && STRESS.data, null, { timeout: 30000 }).catch(() => {}); await p6.click('#views span[data-view="stress"]'); await sleep(1500);
      const ov = await p6.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, cards: document.querySelectorAll("#sInst .scard").length }));
      check("4d. phone width: the stress tab has three asset cards and no horizontal page scroll", ov.cards === 3 && ov.sw <= ov.iw + 1, JSON.stringify(ov)); await c6.close();
    }

    // ---------- 4e. Open positions panel and live accounting (TEST fixture positions on live prices; the browser only renders backend numbers)
    {
      const c7 = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), p7 = await c7.newPage(), e7 = [];
      p7.on("pageerror", e => e7.push(e.message)); p7.on("response", r => { if (r.status() >= 400) e7.push(r.status() + " " + r.url()); });
      await p7.goto(testUrl, { waitUntil: "domcontentloaded" });
      await p7.waitForFunction(() => document.querySelectorAll("#mPositions .opcard").length > 0 && MON.conn === "STREAMING", null, { timeout: 120000 }).catch(() => {});
      const lay = await p7.evaluate(() => ({ p: document.getElementById("mPositions").getBoundingClientRect().top, a: document.getElementById("mAccounts").getBoundingClientRect().top, n: document.querySelectorAll("#mPositions .opcard").length }));
      check("4e. the Open positions panel comes before the account cards and shows cards for the open positions", lay.n > 0 && lay.p < lay.a, JSON.stringify(lay));
      const txt = await p7.locator("#mPositions .opcard").first().innerText();
      const need = [[/account paper:/, "account"], [/LONG|SHORT/, "direction"], [/GROSS P&L AT MARK/i, "gross label"], [/ROI · GROSS, ON INITIAL MARGIN/i, "ROI label"], [/÷ [\d,.]+ USDT initial margin/, "ROI denominator"], [/EST\. NET IF CLOSED NOW/i, "net label"],
        [/Margin allocated/, "margin"], [/Notional/, "notional"], [/Leverage/, "leverage"], [/× margin setting/, "setting"], [/notional ÷ margin now/, "effective"], [/Entry → mark/, "entry/mark"], [/Stop \/ target/, "stop"], [/Risk budget/, "risk"], [/Fees · funding/, "fees"], [/mark OK .* old · book OK .* old/, "freshness"]];
      const miss = need.filter(([re]) => !re.test(txt)).map(x => x[1]);
      check("4e. each card shows account, direction, margin, notional, leverage (setting and effective), entry and mark, gross P&L, ROI with its denominator, net if closed, risk and freshness", miss.length === 0, miss.join(",") || txt.slice(0, 80).replace(/\n/g, " "));
      // independent recomputation from raw API fields, at two different marks
      const sample = () => p7.evaluate(() => { renderMonitorPositions(); return MON.val.positions.map(p => { const L = p.live, s = p.side, q = L.quantity_base, e = L.prices.average_entry, m = L.prices.mark, gross = s * q * (m - e), im = q * e / L.margin.margin_setting_leverage;
        const row = document.querySelector('#mPositions .mrow[data-pid="' + p.position_id + '"]'), num = k => { const t = row ? row.querySelector('[data-f="' + k + '"]').innerText : ""; return parseFloat(t.replace("−", "-").replace(/[^0-9+\-.]/g, "")); };
        return { id: p.position_id, mark: m, gross, apiGross: L.gross_unrealized.value, domGross: num("gross"), roi: gross / im * 100, apiRoi: L.roi.filter(r => r.primary)[0].value, domRoi: num("roi"), im, apiIm: L.margin.initial }; }); });
      const a = await sample(); let b = a; const t0 = Date.now();
      while (Date.now() - t0 < 40000) { await sleep(2000); b = await sample(); if (b.some(y => { const x = a.find(z => z.id === y.id); return x && x.mark !== y.mark; })) break; }
      const all = [...a, ...b], badCalc = all.filter(x => Math.abs(x.gross - x.apiGross) > 1e-6 || Math.abs(x.roi - x.apiRoi) > 1e-6 || Math.abs(x.im - x.apiIm) > 1e-6), badDom = all.filter(x => !(Math.abs(x.domGross - x.apiGross) < 6e-5) || !(Math.abs(x.domRoi - x.apiRoi) < 6e-3));
      const moved = b.some(y => { const x = a.find(z => z.id === y.id); return x && x.mark !== y.mark && x.apiGross !== y.apiGross; });
      check("4e. P&L, ROI and margin equal an independent recomputation from the raw fields (s·q·(mark−entry), ÷ initial margin), in the API and on screen", badCalc.length === 0 && badDom.length === 0 && all.length > 0, `${all.length} samples; calc mismatches ${badCalc.length}; screen mismatches ${badDom.length}`);
      check("4e. a changed mark price changes gross P&L and ROI accordingly", moved, moved ? "mark and P&L both moved between samples" : "the market did not move within 40 s (not a failure of the code, but this check could not be exercised)");
      const col = await p7.evaluate(() => [...document.querySelectorAll("#mPositions .opcard")].map(c => { const g = c.querySelector('[data-f="gross"] span'), t = g.innerText.trim(), rgb = getComputedStyle(g).color; return { t, rgb, v: parseFloat(t.replace("−", "-").replace(/[^0-9+\-.]/g, "")) }; }));
      const UP = "rgb(47, 191, 113)", DOWN = "rgb(229, 72, 77)", TOL = 0.005;      // display tolerance: |P&L| < 0.005 USDT is neutral even when its rounded text carries a sign
      const okc = x => (x.v >= TOL ? x.rgb === UP : x.v <= -TOL ? x.rgb === DOWN : x.rgb !== UP && x.rgb !== DOWN) && (x.v >= TOL ? x.t.startsWith("+") : x.v <= -TOL ? x.t.startsWith("−") : true);
      check("4e. profit/loss colours and signs agree on every card (green +, red −, neutral under the 0.005 USDT display tolerance)", col.length > 0 && col.every(okc), col.map(x => x.t.split(" ")[0] + ":" + (x.rgb === UP ? "green" : x.rgb === DOWN ? "red" : "neutral")).join(" | ").slice(0, 170));
      const ml = await p7.evaluate(() => [...document.querySelectorAll("#mPositions .opcard")].map(c => { const g = k => parseFloat(c.querySelector('[data-f="' + k + '"]').innerText.replace(/[^0-9.]/g, "")); return { margin: g("margin"), notional: g("notional") }; }));
      check("4e. margin and notional are distinct figures (notional ≈ 2× margin at the 2× setting, never displayed as the same number)", ml.length > 0 && ml.every(x => x.margin > 0 && Math.abs(x.notional / x.margin - 2) < 0.01), JSON.stringify(ml[0]));
      // staleness (render test: a backend view with a stale mark is injected into the page; the last valid value must stay visible and labelled)
      const stale = await p7.evaluate(() => { const v = JSON.parse(JSON.stringify(MON.val)), p = v.positions[0], g = p.live.gross_unrealized.value; p.live.prices.mark_status = "STALE"; p.live.prices.mark_age_ms = 61000; p.live.prices.book_status = "STALE"; p.live.prices.book_age_ms = 61000;
        MON.val = v; renderMonitorPositions(); const c = document.querySelector('#mPositions .mrow[data-pid="' + p.position_id + '"]'); return { t: c.innerText, g, shown: c.querySelector('[data-f="gross"]').innerText }; });
      check("4e. STALE inputs are visible (stale mark and stale book chips, ages) and the last valid P&L stays on screen (not zero)", /STALE MARK · last valid value shown/.test(stale.t) && /STALE BOOK/.test(stale.t) && /mark STALE 61\.0 s old/.test(stale.t) && !/^0\.0000/.test(stale.shown.replace(/[+−]/, "")) && Math.abs(parseFloat(stale.shown.replace("−", "-").replace(/[^0-9+\-.]/g, "")) - stale.g) < 6e-5, stale.t.slice(0, 60).replace(/\n/g, " "));
      // ordering and tombstones (front-end logic exercised by replaying frames)
      const tomb = await p7.evaluate(() => { const cur = JSON.parse(JSON.stringify(MON.val)); cur.calc_ts += 1000; monitorAcceptValuation(cur);
        const P = MON.val.positions[0].position_id, n0 = MON.val.positions.length;
        const old = JSON.parse(JSON.stringify(MON.val)); old.calc_ts -= 5000; old.positions = old.positions.slice(0, 1); const acceptedOld = monitorAcceptValuation(old), keptAll = MON.val.positions.length === n0;     // an OLD frame must not roll the display back
        monitorTomb(P); const again = JSON.parse(JSON.stringify(MON.val)); again.calc_ts += 1000; monitorAcceptValuation(again);                   // the position is known closed: a frame that still lists it must not resurrect it
        const resurrected = MON.val.positions.some(p => p.position_id === P); delete MON.tomb[P]; return { acceptedOld, keptAll, resurrected, dropped: MON.staleDropped, filtered: MON.tombFiltered }; });
      check("4e. an old valuation frame is rejected and a closed position is never resurrected by a later frame", tomb.acceptedOld === false && tomb.keptAll === true && tomb.resurrected === false && tomb.dropped >= 1 && tomb.filtered >= 1, JSON.stringify(tomb));
      await p7.evaluate(() => monitorResnapshot("e2e: restore authoritative state")); await sleep(2500);
      // refresh preserves positions; closed positions are not shown as open and appear once in history
      const idsBefore = await p7.evaluate(() => [...document.querySelectorAll("#mPositions .mrow")].map(r => r.dataset.pid).sort());
      await p7.reload({ waitUntil: "domcontentloaded" }); await p7.waitForFunction(() => document.querySelectorAll("#mPositions .opcard").length > 0 || /No open paper positions/.test(document.getElementById("mPositions").innerText), null, { timeout: 30000 }).catch(() => {}); await sleep(2500);
      const domIds = () => p7.evaluate(() => [...document.querySelectorAll("#mPositions .mrow")].map(r => r.dataset.pid).sort());
      let conv = await waitFor(async () => { const api = await getJson(testUrl + "api/paper/snapshot"), dom = await domIds(); const ao = api.positions.map(x => x.position_id).sort(); return JSON.stringify(ao) === JSON.stringify(dom) ? { api, dom } : null; }, 20000, 800);
      const idsAfter = conv ? conv.dom : await domIds(), api = conv ? conv.api : await getJson(testUrl + "api/paper/snapshot");
      const apiOpen = api.positions.map(x => x.position_id).sort(), closedIds = api.recent_closed.map(x => x.position_id);
      await sleep(1500); const histRows = await p7.evaluate(() => [...document.querySelectorAll("#mClosed .mrow")].map(r => r.dataset.pid));
      check("4e. after a refresh the page converges to exactly the backend's open positions; no closed position is shown as open; each closed position appears once in history", !!conv && closedIds.every(i => !idsAfter.includes(i)) && histRows.length === new Set(histRows).size && closedIds.slice(0, 10).every(i => histRows.includes(i)), `before ${idsBefore.length}, converged ${idsAfter.length}, api ${apiOpen.length}, closed ${closedIds.length}, history rows ${histRows.length}`);
      const acc = await p7.locator("#mAccounts").innerText();
      check("4e. account cards show estimated closeout equity, open exposure, pricing completeness and the account-return definition", (acc.match(/Est\. closeout equity/g) || []).length === 3 && (acc.match(/Open exposure/g) || []).length === 3 && (acc.match(/Pricing/g) || []).length === 3 && (acc.match(/Account return/g) || []).length === 3, "");
      check("4e. account cards show the recorded maximum drawdown with its coverage statement", (acc.match(/Max drawdown \(recorded\)/g) || []).length === 3 && (acc.match(/Drawdown coverage/g) || []).length === 3, "");
      const posId = apiOpen[0], det = posId ? await waitFor(async () => { const d = await getJson(testUrl + "api/paper/position?id=" + encodeURIComponent(posId)); return d.timeline && d.timeline.samples.length >= 2 ? d : null; }, 170000, 3000) : null;
      if (posId && det) { await p7.evaluate(id => monitorOpenDetail(id), posId); await p7.waitForFunction(() => /one-minute samples from/.test(document.getElementById("mTimelineNote").innerText), null, { timeout: 20000 }).catch(() => {});
        const tn = await p7.locator("#mTimelineNote").innerText(), cv = await p7.locator("#mTimeline canvas").count(), m = /(\d+) one-minute samples/.exec(tn);
        check("4e. the position detail shows a recorded valuation timeline: samples counted, gaps stated, 'recorded, not reconstructed', a chart drawn, and the count matches the API", /recorded, not reconstructed/.test(tn) && cv > 0 && !!m && Number(m[1]) >= 2 && Number(m[1]) <= det.timeline.samples.length + 2 && det.timeline.coverage.count >= 2, tn.slice(0, 150).replace(/\n/g, " ")); }
      else check("4e. the position detail shows a recorded valuation timeline", false, "no open position with two recorded samples within 170 s");
      const hist = await waitFor(async () => { const d = await getJson(testUrl + "api/paper/closed?limit=300"); return d.closed.length >= 2 ? d : null; }, 150000, 3000);
      if (hist) {
        await p7.evaluate(() => monitorSlow()); await p7.waitForFunction(() => document.querySelectorAll("#mClosedTable .mrow").length > 0, null, { timeout: 20000 }).catch(() => {}); await sleep(800);
        const hd = await p7.locator("#mClosedTable tr").first().innerText(), apiNow = await getJson(testUrl + "api/paper/closed?limit=300"), rowsAll = await p7.locator("#mClosedTable .mrow").count();
        check("4e. history shows margin basis, signal, holding time and a per-trade ROI with its named basis, and states shown / loaded / total", /Initial margin \(USDT\)/.test(hd) && /Signal/.test(hd) && /ROI \(per trade\)/.test(hd) && (await p7.locator("#mClosedTable .mrow").first().innerText()).includes("held") && /Showing \d+ of \d+ loaded closed positions \(\d+ closed in this ledger\)/.test(await p7.locator("#mClosedFoot").innerText()) && rowsAll === Math.min(300, apiNow.closed_total), `${rowsAll} rows, total ${apiNow.closed_total}`);
        const A = apiNow.closed[0].analyst, D = apiNow.closed[0].direction, NAME = { risk_taker: "Risk Taker", balanced: "Balanced Trader", defensive: "Defensive Trader" };
        await p7.selectOption("#hfAnalyst", A); await sleep(300); const nA = await p7.locator("#mClosedTable .mrow").count(), expA = apiNow.closed.filter(x => x.analyst === A).length;
        const namesOk = (await p7.locator("#mClosedTable .mrow td:nth-child(2)").allInnerTexts()).every(t => t.includes(NAME[A]));
        await p7.selectOption("#hfDir", D); await sleep(300); const nAD = await p7.locator("#mClosedTable .mrow").count(), expAD = apiNow.closed.filter(x => x.analyst === A && x.direction === D).length;
        const foot = await p7.locator("#mClosedFoot").innerText();
        await p7.click("#hfClear"); await sleep(300); const nAll = await p7.locator("#mClosedTable .mrow").count();
        check("4e. history filters (account, direction) select exactly the rows an independent count of the API data gives, and Clear restores them", nA === expA && namesOk && nAD === expAD && nAll === rowsAll && new RegExp(`Showing ${nAD} of ${rowsAll} loaded`).test(foot), `account ${nA}/${expA}, +direction ${nAD}/${expAD}, cleared ${nAll}/${rowsAll}`);
        const c0 = apiNow.closed[0], roiExp = c0.closed.net_usdt / (c0.entry_qty * c0.entry_fill_price / 2) * 100, roiShown = await p7.evaluate(id => { const r = document.querySelector('#mClosedTable .mrow[data-pid="' + id + '"]'); return r ? r.children[12].innerText : null; }, c0.position_id);
        check("4e. a closed trade's ROI equals booked net ÷ (entry notional ÷ 2× margin setting), shown with that basis", roiShown !== null && Math.abs(parseFloat(roiShown.replace("−", "-").replace(/[^0-9+\-.]/g, "")) - roiExp) < 0.006 && Math.abs(c0.closed.net_return_on_initial_margin_pct - roiExp) < 1e-6 && /initial margin/.test(c0.closed.roi_basis), `${roiShown && roiShown.split("\n")[0]} vs ${roiExp.toFixed(3)}%`);
      } else check("4e. history filters and ROI basis", false, "no closed position within 150 s (could not be exercised)");
      check("4e. no page errors or failed requests on the Open positions panel", e7.length === 0, e7.join(" | ").slice(0, 160));
      await c7.close();
      const c8 = await browser.newContext({ viewport: { width: 390, height: 844 } }), p8 = await c8.newPage(); await p8.goto(testUrl, { waitUntil: "domcontentloaded" });
      await p8.waitForFunction(() => document.querySelectorAll("#mPositions .opcard").length > 0, null, { timeout: 90000 }).catch(() => {}); await sleep(1500);
      const mo = await p8.evaluate(() => { const iw = innerWidth, cells = [...document.querySelectorAll("#mPositions .opcard td, #mPositions .opbig, #mPositions .oplbl")];     // a value is cut off when it extends past the right edge of ITS CARD (the card or its container scrolls instead of wrapping)
      return { sw: document.scrollingElement.scrollWidth, iw, cards: document.querySelectorAll("#mPositions .opcard").length, clipped: cells.filter(c => c.getBoundingClientRect().right > c.closest(".opcard").getBoundingClientRect().right + 1 || c.scrollWidth > c.clientWidth + 1).length }; });
      check("4e. phone width: position cards are fully readable (no value cut off at the right edge, no horizontal page scroll)", mo.cards > 0 && mo.clipped === 0 && mo.sw <= mo.iw + 1, JSON.stringify(mo)); await c8.close();
    }

    // ---------- 5. mobile width + static page
    const c3 = await browser.newContext({ viewport: { width: 390, height: 844 } }), p3 = await c3.newPage(), e3 = [];
    p3.on("pageerror", e => e3.push(e.message));
    await p3.goto(testUrl, { waitUntil: "domcontentloaded" });
    await p3.waitForFunction(() => MON.snap && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    const overflow = await p3.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
    check("5. phone width: no horizontal page scroll (wide tables scroll inside their cards)", overflow.sw <= overflow.iw + 1 && e3.length === 0, `scrollWidth ${overflow.sw} vs ${overflow.iw}`);
    const tabs = await p3.evaluate(() => { const bar = document.querySelector("#views"), iw = window.innerWidth; return [...bar.querySelectorAll("span")].map(sp => { const r = sp.getBoundingClientRect(); return { t: sp.textContent, ok: r.left >= 0 && r.right <= iw + 1 }; }); });
    check("5. phone width: all six tabs are fully visible (none clipped by the right edge)", tabs.length === 6 && tabs.every(t => t.ok), tabs.filter(t => !t.ok).map(t => t.t).join(","));
    if (shots) await p3.screenshot({ path: path.join(shots, "monitor-test-mobile.png"), fullPage: false });
    await c3.close();
    if (staticUrl) {
      const c4 = await browser.newContext({ viewport: { width: 1280, height: 900 } }), p4 = await c4.newPage(), e4 = [];
      p4.on("pageerror", e => e4.push(e.message));
      await p4.goto(staticUrl, { waitUntil: "domcontentloaded" }); await sleep(2500);
      await p4.locator('#views span[data-view="monitor"]').click();
      const t = await p4.locator("#monitorView").innerText();
      await p4.locator('#views span[data-view="news"]').click();
      check("5. static page: the News tab says it needs the worker and why, with no invented items", /No local worker on this page/.test(await p4.locator("#nItems").innerText()) && (await p4.locator("#nItems .pf").count()) === 0, "");
      await p4.locator('#views span[data-view="trade"]').click(); await p4.waitForFunction(() => /Producer: started/.test(document.getElementById("journal").innerText), null, { timeout: 30000 }).catch(() => {}); await sleep(2500);
      const jt = await p4.locator("#journal").innerText(), jh = await p4.locator("#journal").evaluate(e => e.previousElementSibling.innerText), openStates = await p4.locator("#journal .legacy-open").evaluateAll(a => a.map(x => x.dataset.state));
      check("5. legacy scheduled simulator panel: labelled LEGACY and hypothetical, explains $5 margin and leverage, amounts in USDT (not $), producer's last run with its age, and no 'runs every 15 minutes ... even when this page is closed' claim", /LEGACY SCHEDULED SIMULATOR/i.test(jh) && /hypothetical/i.test(jh) && /What "\$5 at 50×" means/.test(jt) && /\$250 notional/.test(jt) && /last successful run .* UTC \(/.test(jt) && /GitHub throttles scheduled workflows/.test(jt) && !/even when this page is closed/i.test(jt + jh) && /USDT/.test(jt) && !/[+−]\$\d/.test(jt) && /different from the worker's Risk Taker, Balanced and Defensive/.test(jt), jh.slice(0, 80));
      check("5. legacy open trades are checked against final candles and each gets an explicit state (never silently shown as live)", openStates.length > 0 && openStates.every(x => ["STOP", "TARGET", "TIME_LIMIT", "OPEN", "INCOMPLETE", "NO_CANDLES"].includes(x)) && /recorded nowhere|Recorded nowhere|not part of any account/.test(jt), openStates.join(","));
      await p4.locator('#views span[data-view="stress"]').click(); await sleep(300);
      const sbs = (await p4.locator("#stressBar").innerText()).replace(/\n/g, " ");
      check("5. static page: the stress tab and strip say a worker is needed and show nothing simulated", /No local worker on this page/.test(await p4.locator("#sInst").innerText()) && /needs the local worker/.test(sbs) && (await p4.locator("#sInst .scard").count()) === 0, sbs.slice(0, 120));
      check("5. static page (no worker, like the public site): the monitor says so and shows nothing simulated", /not served by the local worker/.test(t) && /nothing is simulated in its place/.test(t) && (await p4.locator("#mPositions .mrow").count()) === 0 && e4.length === 0, e4.join("|"));
      await c4.close();
    }
  } finally {
    await browser.close(); await stop(worker); fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("ABORTED: " + e.message); process.exit(2); });
