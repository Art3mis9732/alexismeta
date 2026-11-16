"use strict";
/* Local HTTP API + static site. Binds 127.0.0.1 only. GET/HEAD only. No CORS headers (same-origin use).
 * Host header must be localhost/127.0.0.1 (mitigates DNS rebinding). Errors are sanitised: no stack traces,
 * no file paths, no environment values are ever returned. */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const ID_RE = /^[a-z]+:[a-z_]+:[A-Z0-9]{2,20}$/;
const INTERVALS = new Set(["1m", "15m"]);

function intParam(v, def, min, max) {
  if (v === null || v === undefined || v === "") return def;
  if (!/^\d{1,13}$/.test(v)) return NaN;
  const n = Number(v); return n < min || n > max ? NaN : n;
}

function createServer({ api, staticDir, port }) {
  const root = path.resolve(staticDir);
  const send = (res, code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const err = (res, code, msg) => send(res, code, { error: msg });

  const server = http.createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return err(res, 405, "method not allowed");
      const host = String(req.headers.host || "");
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return err(res, 421, "bad host");
      if ((req.url || "").length > 2048) return err(res, 414, "uri too long");
      const u = new URL(req.url, "http://localhost");
      const q = k => u.searchParams.get(k);
      if (u.pathname.startsWith("/api/")) {
        const p = u.pathname;
        if (p === "/api/health") return send(res, 200, api.health());
        if (p === "/api/instruments") return send(res, 200, api.instruments());
        const id = q("instrument");
        if (p === "/api/feed-events") { const n = intParam(q("limit"), 50, 1, 500); return Number.isNaN(n) ? err(res, 400, "bad limit") : send(res, 200, api.feedEvents(n)); }
        if (!id || !ID_RE.test(id)) return err(res, 400, "bad or missing instrument");
        if (!api.hasInstrument(id)) return err(res, 404, "unknown instrument");
        if (p === "/api/candles") {
          const iv = q("interval") || "1m", n = intParam(q("limit"), 500, 1, 2000), before = intParam(q("before"), null, 0, 9e12);
          if (!INTERVALS.has(iv) || Number.isNaN(n) || Number.isNaN(before)) return err(res, 400, "bad interval/limit/before");
          return send(res, 200, api.candles(id, iv, n, before));
        }
        if (p === "/api/ticker") return send(res, 200, api.ticker(id));
        if (p === "/api/trades") { const n = intParam(q("limit"), 100, 1, 1000); return Number.isNaN(n) ? err(res, 400, "bad limit") : send(res, 200, api.trades(id, n)); }
        if (p === "/api/book") { const n = intParam(q("levels"), 20, 1, 50); return Number.isNaN(n) ? err(res, 400, "bad levels") : send(res, 200, api.book(id, n)); }
        return err(res, 404, "not found");
      }
      // static files from docs/ (path traversal safe)
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(root, "." + rel);
      if (!file.startsWith(root + path.sep)) return err(res, 403, "forbidden");
      fs.stat(file, (e, st) => {
        if (e || !st.isFile()) return err(res, 404, "not found");
        const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Length": st.size });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) {
      return err(res, 500, "internal error");
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxHeadersCount = 50;
  return server;
}

module.exports = { createServer };
