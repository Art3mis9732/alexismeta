"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { tick, stressSevere, ALLOWED } = require("../research/lab_loop");
const rig = (over = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-")), ran = [], now = { t: 1_800_000_000_000 };
  return { dir, ran, now, deps: { registryDir: dir, now: () => now.t, getStress: async () => ({ instruments: [{ severity: "NORMAL" }, { severity: "ELEVATED" }], market_wide: false }), freeBytes: () => 50 * 1024 ** 3, runStep: async (s) => { ran.push(s); return { ok: true }; }, ...over } }; };
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "loop_state.json"), "utf8"));

test("loop: a normal tick runs only the requested allowed steps and records COMPLETED without any promotion or final scoring ability", async () => {
  const r = rig(); const st = await tick({ steps: ["fetch", "dataset"] }, r.deps);
  assert.deepEqual(r.ran, ["fetch", "dataset"]); assert.equal(st.last_outcome, "COMPLETED"); assert.equal(st.can_promote, false); assert.equal(st.can_score_final, false); assert.equal(state(r.dir).last_outcome, "COMPLETED");
  assert.ok(!fs.existsSync(path.join(r.dir, "loop.lock")), "lock released");
});
test("loop: refuses to start during HIGH or CRITICAL stress (asset or market-wide) and runs nothing", async () => {
  for (const api of [{ instruments: [{ severity: "HIGH_STRESS" }], market_wide: false }, { instruments: [{ severity: "CRITICAL" }], market_wide: false }, { instruments: [{ severity: "NORMAL" }], market_wide: true }]) {
    const r = rig({ getStress: async () => api }); const st = await tick({ steps: ["fetch"] }, r.deps); assert.equal(st.last_outcome, "SKIPPED_STRESS"); assert.deepEqual(r.ran, []);
  }
});
test("loop: stress unknown (worker unreachable) is allowed but labelled, never silently treated as calm", async () => {
  const r = rig({ getStress: async () => null }); const st = await tick({ steps: ["fetch"] }, r.deps); assert.equal(st.last_outcome, "COMPLETED_STRESS_UNKNOWN"); assert.match(st.detail, /could not be checked/); assert.equal(stressSevere(null), null);
});
test("loop: final scoring, promotion and unknown steps are refused outright", async () => {
  for (const s of ["final", "promote", "score_final", "deploy"]) { const r = rig(); const st = await tick({ steps: ["fetch", s] }, r.deps); assert.equal(st.last_outcome, "REFUSED_STEP"); assert.deepEqual(r.ran, []); }
  assert.deepEqual(ALLOWED, ["fetch", "dataset", "validate"]);
});
test("loop: a held lock blocks a second run; a stale lock is reclaimed", async () => {
  const r = rig(); fs.writeFileSync(path.join(r.dir, "loop.lock"), "1"); const lockTime = fs.statSync(path.join(r.dir, "loop.lock")).mtimeMs; r.now.t = lockTime + 60_000;
  assert.equal((await tick({ steps: ["fetch"], maxMinutes: 60 }, r.deps)).last_outcome, "SKIPPED_LOCKED"); assert.deepEqual(r.ran, []);
  r.now.t = lockTime + 61 * 60_000; assert.equal((await tick({ steps: ["fetch"], maxMinutes: 60 }, r.deps)).last_outcome, "COMPLETED"); assert.deepEqual(r.ran, ["fetch"]);
});
test("loop: low disk, trial cap and the time budget each stop the run with a recorded reason", async () => {
  assert.equal((await tick({ steps: ["fetch"] }, rig({ freeBytes: () => 1000 }).deps)).last_outcome, "SKIPPED_DISK");
  const r = rig(); fs.writeFileSync(path.join(r.dir, "trials.jsonl"), Array.from({ length: 9 }, (_, i) => JSON.stringify({ trial_id: i + 1 })).join("\n") + "\n");
  assert.equal((await tick({ steps: ["validate"] }, r.deps)).last_outcome, "SKIPPED_TRIAL_CAP"); assert.deepEqual(r.ran, []);
  const q = rig(); q.deps.runStep = async (s) => { q.ran.push(s); q.now.t += 40 * 60_000; return { ok: true }; };
  const st = await tick({ steps: ["fetch", "dataset", "validate"], maxMinutes: 60 }, q.deps); assert.equal(st.last_outcome, "STOPPED_TIME_BUDGET"); assert.deepEqual(q.ran, ["fetch", "dataset"]);
});
test("loop: a failing step is recorded and stops the run; the lock is always released", async () => {
  const r = rig({ runStep: async (s) => ({ ok: false, detail: "boom" }) }); const st = await tick({ steps: ["fetch", "dataset"] }, r.deps);
  assert.equal(st.last_outcome, "FAILED_STEP"); assert.match(st.detail, /boom/); assert.ok(!fs.existsSync(path.join(r.dir, "loop.lock")));
});
