"use strict";
/* Bounded research loop for the user's own machine (manual or scheduled). It is NOT a trading component and it cannot promote anything.
 *   node research/lab_loop.js --once [--worker http://127.0.0.1:8787] [--steps fetch,dataset,validate] [--max-minutes 60]
 * What it may do: refresh PUBLIC candles, rebuild the pre-registered dataset, run the VALIDATION stage. What it can never do (hard-coded): score FINAL, register or promote a model,
 * touch the forward database, place or change a paper trade. FINAL is a one-time command a person runs (`python -m modellab.score_final`) after reading the pre-registration.
 * Guards, each recorded as the tick's outcome: another run active (lock), market stress HIGH/CRITICAL (asset or market-wide) on the local worker, low disk, trial cap reached, time budget. */
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), cp = require("node:child_process");
const ROOT = path.join(__dirname, ".."), REG = path.join(ROOT, "research", "registry"), ALLOWED = ["fetch", "dataset", "validate"], MIN_FREE = 2 * 1024 ** 3, CAP = 40;
const SEVERE = new Set(["HIGH", "HIGH_STRESS", "CRITICAL"]);

function getStressHttp(worker, timeoutMs = 4000) {
  return new Promise((resolve) => { const u = new URL("/api/stress", worker), req = http.get(u, { timeout: timeoutMs }, r => { let s = ""; r.on("data", d => s += d); r.on("end", () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } }); }); req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); }); });
}
/** true when any instrument or the market as a whole is HIGH or CRITICAL; null = unknown (worker unreachable or unreadable) */
function stressSevere(api) {
  if (!api || !Array.isArray(api.instruments)) return null;
  const mw = api.market_wide === true || (api.market_wide && typeof api.market_wide === "object" && (api.market_wide.active === true || SEVERE.has(String(api.market_wide.severity || "").toUpperCase())));
  const sev = api.instruments.map(i => i.severity).filter(Boolean);
  if (mw) return true;
  return sev.some(s => SEVERE.has(String(s).toUpperCase()));
}
function defaults() {
  return { now: () => Date.now(), registryDir: REG, getStress: (w) => getStressHttp(w), freeBytes: () => { try { const s = fs.statfsSync(ROOT); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; } },
    runStep: (name) => { const cmds = { fetch: [["node", ["research/fetch_native.js", "730"]], ["node", ["scripts/stress_fetch_1m.js", "730"]]], dataset: [["node", ["research/dataset.js"]]], validate: [["python3", ["-c", "from modellab import fit; import json; print(json.dumps(fit.run_validation('data/research/dataset-v1','research/registry'), default=str)[:400])"]]] };
      for (const [c, a] of cmds[name]) { const r = cp.spawnSync(c, a, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } }); if (r.status !== 0) return { ok: false, detail: String(r.stderr || r.error || "").slice(0, 300) }; } return { ok: true }; } };
}
async function tick(opts = {}, deps = {}) {
  const d = { ...defaults(), ...deps }, o = { steps: ["fetch", "dataset"], worker: "http://127.0.0.1:8787", maxMinutes: 60, ...opts }, dir = d.registryDir, stateFile = path.join(dir, "loop_state.json"), lock = path.join(dir, "loop.lock");
  fs.mkdirSync(dir, { recursive: true });
  const save = (outcome, detail, steps = []) => { const st = { state: "IDLE", last_tick_utc: new Date(d.now()).toISOString(), last_outcome: outcome, detail, steps_run: steps, can_promote: false, can_score_final: false }; fs.writeFileSync(stateFile, JSON.stringify(st, null, 1)); return st; };
  const bad = o.steps.filter(s => !ALLOWED.includes(s));
  if (bad.length) return save("REFUSED_STEP", `not allowed in the loop: ${bad.join(", ")} (final scoring and promotion are manual)`);
  if (fs.existsSync(lock)) { const age = d.now() - fs.statSync(lock).mtimeMs; if (age < o.maxMinutes * 60000) return save("SKIPPED_LOCKED", "another run is active"); fs.unlinkSync(lock); }
  const stress = stressSevere(await d.getStress(o.worker));
  if (stress === true) return save("SKIPPED_STRESS", "market stress is HIGH or CRITICAL on the local worker; research does not start during stress");
  if (d.freeBytes() < MIN_FREE) return save("SKIPPED_DISK", "less than 2 GB free");
  const tf = path.join(dir, "trials.jsonl"), used = fs.existsSync(tf) ? fs.readFileSync(tf, "utf8").split("\n").filter(Boolean).length : 0;
  if (o.steps.includes("validate") && used >= CAP - 32) return save("SKIPPED_TRIAL_CAP", `${used} of ${CAP} trials used; a new pre-registration version is required before another validation run`);
  fs.writeFileSync(lock, String(process.pid)); const ran = [], t0 = d.now();
  try {
    for (const s of o.steps) {
      if (d.now() - t0 > o.maxMinutes * 60000) return save("STOPPED_TIME_BUDGET", `stopped before ${s}`, ran);
      const r = await d.runStep(s); ran.push({ step: s, ok: r.ok }); if (!r.ok) return save("FAILED_STEP", `${s}: ${r.detail || "failed"}`, ran);
    }
    return save(stress === null ? "COMPLETED_STRESS_UNKNOWN" : "COMPLETED", stress === null ? "the local worker was not reachable, so market stress could not be checked" : "ok", ran);
  } finally { try { fs.unlinkSync(lock); } catch (e) { /* already gone */ } }
}
if (require.main === module) {
  const a = process.argv, g = (k, dflt) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : dflt; };
  tick({ steps: g("--steps", "fetch,dataset").split(","), worker: g("--worker", "http://127.0.0.1:8787"), maxMinutes: Number(g("--max-minutes", 60)) }).then(s => { console.log(JSON.stringify(s)); process.exit(0); });
}
module.exports = { tick, stressSevere, ALLOWED };
