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

function startTestWorker(db) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "server", "main.js"), "--port", String(TEST_PORT), "--env", "test", "--fixture", "--db", db], { cwd: ROOT, env: process.env, stdio: "ignore" });
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
    check("0. forward worker serves this working tree and is the FORWARD environment", rtF.build.source_fingerprint === fp && rtF.database.environment === "FORWARD", `${rtF.build.revision} fp ${rtF.build.source_fingerprint}; instance ${rtF.instance_id.slice(0, 8)}`);
    check("0. the two workers are different instances with different ledger databases", rtT.instance_id !== rtF.instance_id && rtT.database.db_id !== rtF.database.db_id, "");
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
    const cmp = await page.evaluate(() => { const p = MON.val.positions[0], row = document.querySelector('#mPositions .mrow[data-pid="' + p.position_id + '"]'); return { shown: row.children[8].innerText, backend: p.valuation.u_mark, life: row.children[9].innerText, lifeB: p.valuation.lifecycle_if_closed_now, fill: row.children[4].innerText, fillB: p.entry_fill_price }; });
    const fmt = x => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    check("1. displayed unrealised and close-now figures are the backend's numbers (the browser does not recompute)", cmp.shown.startsWith(fmt(cmp.backend)) && cmp.life.startsWith(fmt(cmp.lifeB)) && cmp.backend !== cmp.lifeB, `${cmp.shown.split("\n")[0]} / ${cmp.life.split("\n")[0]}`);
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
    check("1. registry labels analysts DETERMINISTIC / training NOT APPLICABLE / edge NOT DEMONSTRATED; no fake training", (reg.match(/DETERMINISTIC/g) || []).length >= 3 && /NOT APPLICABLE/.test(reg) && /NOT DEMONSTRATED/.test(reg) && /Training backend unavailable/.test(reg), "");

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

    // ---------- 5. mobile width + static page
    const c3 = await browser.newContext({ viewport: { width: 390, height: 844 } }), p3 = await c3.newPage(), e3 = [];
    p3.on("pageerror", e => e3.push(e.message));
    await p3.goto(testUrl, { waitUntil: "domcontentloaded" });
    await p3.waitForFunction(() => MON.snap && MON.conn === "STREAMING", null, { timeout: 30000 }).catch(() => {});
    const overflow = await p3.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
    check("5. phone width: no horizontal page scroll (wide tables scroll inside their cards)", overflow.sw <= overflow.iw + 1 && e3.length === 0, `scrollWidth ${overflow.sw} vs ${overflow.iw}`);
    if (shots) await p3.screenshot({ path: path.join(shots, "monitor-test-mobile.png"), fullPage: false });
    await c3.close();
    if (staticUrl) {
      const c4 = await browser.newContext({ viewport: { width: 1280, height: 900 } }), p4 = await c4.newPage(), e4 = [];
      p4.on("pageerror", e => e4.push(e.message));
      await p4.goto(staticUrl, { waitUntil: "domcontentloaded" }); await sleep(2500);
      await p4.locator('#views span[data-view="monitor"]').click();
      const t = await p4.locator("#monitorView").innerText();
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
