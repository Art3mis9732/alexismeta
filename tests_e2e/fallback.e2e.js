"use strict";
/* Worker-death fallback check. WARNING: it STOPS the worker serving the URL (SIGINT via pkill on the port).
 *   node tests_e2e/fallback.e2e.js        (expects a worker started with --port 8787) */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
(async () => {
  const b = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1" } });
  const p = await b.newPage(); const sockets = [];
  p.on("websocket", ws => sockets.push(ws.url()));
  await p.goto("http://127.0.0.1:8787/");
  await p.waitForFunction(() => /via local worker/.test(document.getElementById("mode").innerText), null, { timeout: 30000 });
  console.log("before:", (await p.locator("#mode").innerText()).slice(0, 60), "| bitget sockets:", sockets.length);
  try { execSync('pkill -INT -f "server/main[.]js --port 8787"'); } catch (e) { /* pkill exit codes are not errors here */ }
  await p.waitForFunction(() => /stopped responding/.test(document.getElementById("worker").innerText), null, { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => /LIVE · Bitget public data/.test(document.getElementById("mode").innerText), null, { timeout: 20000 }).catch(() => {});
  const w = await p.locator("#worker").innerText(), m = await p.locator("#mode").innerText();
  console.log("after worker stop:", w, "|", m.slice(0, 60), "| bitget sockets:", sockets.length);
  const ok = /stopped responding/.test(w) && /LIVE · Bitget public data/.test(m) && sockets.some(u => /ws\.bitget\.com/.test(u));
  console.log(ok ? "PASS fallback" : "FAIL fallback");
  await b.close(); process.exit(ok ? 0 : 1);
})();
