"use strict";
/* Runtime identity: which build is this process, which database does it own, since when.
 * Nothing here exposes filesystem paths, environment values or secrets. The source fingerprint is a hash of the code
 * files this process was started from; tests recompute it from the working tree to prove they are talking to the
 * build they think they are (a stale worker on another port has a different fingerprint or revision). */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const API_SCHEMA_VERSION = "api-v2";
const ROOT = path.resolve(__dirname, "..");

function listFiles() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) out.push(p); } };
  walk(path.join(ROOT, "server"));
  for (const f of ["docs/index.html", "docs/patterns.js", "docs/monitor.js", "docs/news.js"]) out.push(path.join(ROOT, f));
  return out.sort();
}
/** sha256 over the served source files (relative name + content), first 16 hex chars. */
function sourceFingerprint() {
  const h = crypto.createHash("sha256");
  for (const f of listFiles()) { h.update(path.relative(ROOT, f).replace(/\\/g, "/")); h.update("\0"); h.update(fs.readFileSync(f)); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}
function git(args) {
  try { return require("node:child_process").execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch (e) { return null; }
}
/** Captured ONCE at process start: the identity of the code that is actually running. */
function buildInfo() {
  const rev = git(["rev-parse", "--short=12", "HEAD"]), st = git(["status", "--porcelain", "--", "server", "docs/index.html", "docs/patterns.js", "docs/monitor.js", "docs/news.js"]);
  return { revision: rev || "unknown", dirty: st === null ? null : st.length > 0, source_fingerprint: sourceFingerprint(), captured_at: Date.now() };
}

module.exports = { API_SCHEMA_VERSION, buildInfo, sourceFingerprint };
