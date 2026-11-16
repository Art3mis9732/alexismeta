"use strict";
/* Browser check of the honest status labels (Phase 3). NOT part of `npm test`: it needs Playwright + Chromium and
 * network access to Bitget. Usage:
 *   node tests_e2e/status.e2e.js <worker-url> <static-url> [screenshotDir]
 * e.g. node tests_e2e/status.e2e.js http://127.0.0.1:8787/ http://127.0.0.1:8788/
 * Behind an HTTPS proxy (cloud container) the HTTPS_PROXY variable is passed to Chromium.
 *
 * Checks:
 *   1. worker-served page: LIVE label from real data; worker strip shows feeds and ANALYSIS ONLY
 *   2. static page (like GitHub Pages): no worker -> says so; still LIVE from the browser's own stream
 *   3. a WebSocket that answers pings but sends no market data -> STALE, never LIVE      (defect A-01)
 *   4. model card never calls the score a chance/probability                               (defect A-02)
 *   5. existing workflows: Buy/Sell, Patterns, Indicators views render; coin switch works; no page errors */
const { chromium } = require("playwright");

async function main() {
  const [workerUrl, staticUrl, shots] = process.argv.slice(2);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
  const browser = await chromium.launch({ proxy });
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

  async function open(url, { silentWs = false, cutAfterMs = null } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [], sockets = [], tickerBodies = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("websocket", ws => sockets.push(ws.url()));
    page.on("response", async r => { if (/api\/ticker\?instrument=bitget:perp:BTCUSDT/.test(r.url())) { try { tickerBodies.push((await r.json()).ticker); } catch (e) { /* ignore */ } } });
    if (silentWs) {
      await page.routeWebSocket(/ws\.bitget\.com/, ws => { ws.onMessage(m => { if (m === "ping") ws.send("pong"); }); });
    } else if (cutAfterMs !== null) {          // real data first, then the feed goes quiet but pongs keep coming
      await page.routeWebSocket(/ws\.bitget\.com/, ws => {
        const server = ws.connectToServer(); let cut = false; setTimeout(() => { cut = true; }, cutAfterMs);
        ws.onMessage(m => { if (cut && m === "ping") return ws.send("pong"); server.send(m); });
        server.onMessage(m => { if (!cut) ws.send(m); });
      });
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { ctx, page, errors, sockets, tickerBodies };
  }
  const text = (page, sel) => page.locator(sel).innerText();

  // 1. worker-served
  if (workerUrl) {
    const { ctx, page, errors, sockets, tickerBodies } = await open(workerUrl);
    await page.waitForFunction(() => /LIVE/.test(document.getElementById("mode").innerText), null, { timeout: 30000 }).catch(() => {});
    const mode = await text(page, "#mode");
    check("worker page: LIVE from real data", /● LIVE/.test(mode) && /s ago/.test(mode), mode);
    await page.waitForFunction(() => /Local worker/.test(document.getElementById("worker").innerText), null, { timeout: 15000 }).catch(() => {});
    const w = await text(page, "#worker");
    check("worker page: worker strip shows feeds + ANALYSIS ONLY", /Local worker/.test(w) && /ANALYSIS ONLY/.test(w) && /ticker HEALTHY/.test(w), w);
    check("worker page: label says data comes via the local worker", /via local worker/.test(mode), mode);
    await page.waitForTimeout(6000);
    check("worker page: this tab opened NO connection to Bitget (one collector per machine)", sockets.filter(u => /bitget/.test(u)).length === 0, JSON.stringify(sockets));
    const shown = Number((await text(page, "#tPrice")).replace(/,/g, ""));
    const recent = tickerBodies.slice(-4).map(t => t && Number(t.last));
    check("worker page: displayed price equals a /api/ticker value the page just received", recent.includes(shown), `shown ${shown}, last API values ${recent.join(", ")}`);
    await page.locator('#coins span[data-sym="ETHUSDT"]').click();
    await page.waitForFunction(() => /ETH perp/.test(document.getElementById("worker").innerText), null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => /No demonstrated edge/.test(document.getElementById("analystsBody").innerText), null, { timeout: 15000 }).catch(() => {});
    const an = await text(page, "#analystsCard");
    check("worker page: v1 analysts card shows all three with an explicit 'No demonstrated edge' status and no probability",
      (an.match(/No demonstrated edge/g) || []).length === 3 && /Risk Taker/.test(an) && /Balanced Trader/.test(an) && /Defensive Trader/.test(an) && !/\d+(\.\d+)?\s*%\s*(chance|probability)/i.test(an), an.slice(0, 200).replace(/\n/g, " "));
    await page.waitForFunction(() => document.querySelectorAll("#newsBody a").length > 0, null, { timeout: 15000 }).catch(() => {});
    const links = await page.locator("#newsBody a").evaluateAll(as => as.map(a => [a.href, a.rel]));
    check("worker page: official news listed with https .gov links opened safely (noopener)", links.length > 0 && links.every(([h, r]) => /^https:\/\/www\.(sec|federalreserve)\.gov\//.test(h) && /noopener/.test(r)), `${links.length} links`);
    check("worker page: coin switch updates the worker strip", /ETH perp/.test(await text(page, "#worker")), "");
    await page.waitForFunction(() => /LIVE · .*last ETH update/.test(document.getElementById("mode").innerText), null, { timeout: 15000 }).catch(() => {});
    check("worker page: after the switch the label reports ETH data (RECOVERING until the first ETH message is honest)", /LIVE · .*last ETH update/.test(await text(page, "#mode")), await text(page, "#mode"));
    if (shots) await page.screenshot({ path: shots + "/worker-mode.png", fullPage: false });
    check("worker page: no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // 2. static (no /api) + 4. model label + 5. views
  if (staticUrl) {
    const { ctx, page, errors } = await open(staticUrl);
    await page.waitForFunction(() => /LIVE/.test(document.getElementById("mode").innerText), null, { timeout: 30000 }).catch(() => {});
    check("static page: LIVE from the browser stream", /● LIVE/.test(await text(page, "#mode")), await text(page, "#mode"));
    const w = await text(page, "#worker");
    check("static page: says there is no local worker and that execution is analysis only", /No local worker/.test(w) && /analysis only/.test(w), w);
    check("static page: worker-only analysts card is hidden", !(await page.locator("#analystsCard").isVisible()), "");
    const card = await text(page, "#modelCard");
    check("model card: no 'chance' wording; labelled uncalibrated", !/chance higher|Chance higher|chance the price/i.test(card.replace(/does not mean a 60% chance/, "")) && /uncalibrated/i.test(card), card.slice(0, 160).replace(/\n/g, " "));
    for (const v of ["patterns", "indicators", "trade"]) {
      await page.locator(`#views span[data-view="${v}"]`).click();
      const vis = await page.locator(`#${v === "trade" ? "tradeView" : v + "View"}`).isVisible();
      check(`view '${v}' renders`, vis, "");
    }
    await page.waitForTimeout(1500);
    check("static page: no page errors", errors.length === 0, errors.join(" | "));
    if (shots) await page.screenshot({ path: shots + "/static-mode.png", fullPage: false });
    await ctx.close();
  }

  // 3. connected but silent (only pongs)
  if (staticUrl) {
    const { ctx, page } = await open(staticUrl, { silentWs: true });
    await page.waitForTimeout(3000);
    const m1 = await text(page, "#mode");
    check("silent socket: never shows LIVE", !/LIVE/.test(m1), m1);
    check("silent socket: shows RECOVERING (connected, no data yet)", /RECOVERING/.test(m1), m1);
    await ctx.close();
  }

  // 3b. real data, then silence with pongs still answered -> must turn STALE (this is exactly defect A-01)
  if (staticUrl) {
    const { ctx, page } = await open(staticUrl, { cutAfterMs: 8000 });
    await page.waitForFunction(() => /LIVE/.test(document.getElementById("mode").innerText), null, { timeout: 20000 }).catch(() => {});
    const before = await text(page, "#mode");
    await page.waitForTimeout(8000 + 12000);
    const after = await text(page, "#mode");
    check("data then silence (pongs only): LIVE turns STALE", /LIVE/.test(before) && /STALE/.test(after) && !/LIVE/.test(after), `${before}  ->  ${after}`);
    if (shots) await page.screenshot({ path: shots + "/stale-mode.png", fullPage: false });
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
