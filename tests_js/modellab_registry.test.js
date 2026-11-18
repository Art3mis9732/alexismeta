"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { readLab, CAP } = require("../server/modellab_registry");
const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lab-")); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), typeof v === "string" ? v : JSON.stringify(v)); return d; };
const trial = (id, family, kind = "config") => JSON.stringify({ trial_id: id, kind, family }) + "\n";

test("lab registry: a missing directory means no research run, never an error and never a model", () => {
  const r = readLab("/nonexistent-lab-dir"); assert.equal(r.state, "NO_RESEARCH_RUN"); assert.deepEqual(r.models, []); assert.equal(r.promoted, false); assert.equal(r.trials.count, 0);
});
test("lab registry: nothing selected on validation is REJECTED_ON_VALIDATION and lists no model", () => {
  const r = readLab(mk({ "trials.jsonl": trial(1, "lr") + trial(2, "hgb"), "validation_result.json": { val_base_logloss: 0.65, selected: null, reason: "REJECTED_ON_VALIDATION: none", n_config_trials: 2 } }));
  assert.equal(r.state, "REJECTED_ON_VALIDATION"); assert.deepEqual(r.models, []); assert.equal(r.trials.count, 2); assert.match(r.headline, /final segment was never read/);
});
test("lab registry: a failed final gate is REJECTED, the model is listed as NOT_DEMONSTRATED and never promoted", () => {
  const sel = { family: "lr", params: { C: 0.1 }, theta: 0.6 };
  const r = readLab(mk({ "validation_result.json": { selected: sel }, "final_result.json": { verdict: "REJECTED", trades: 500, mean_R: -0.1, criteria: { "2_ci_lower_gt_0": false }, selected: sel } }));
  assert.equal(r.state, "REJECTED"); assert.equal(r.models.length, 1); assert.equal(r.models[0].edge, "NOT_DEMONSTRATED"); assert.equal(r.models[0].promoted, false); assert.match(r.headline, /did NOT clear/);
});
test("lab registry: a passing final gate is only a candidate for shadow evaluation, still not promoted", () => {
  const sel = { family: "lr", params: {}, theta: 0.6 };
  const r = readLab(mk({ "final_result.json": { verdict: "PASS_CANDIDATE_FOR_SHADOW", trades: 900, mean_R: 0.12, selected: sel } }));
  assert.equal(r.state, "CANDIDATE_FOR_SHADOW_NOT_PROMOTED"); assert.equal(r.models[0].promoted, false); assert.equal(r.promoted, false); assert.match(r.models[0].edge, /AWAITING_FORWARD_SHADOW/);
});
test("lab registry: insufficient sample is a rejection, malformed files are reported not thrown", () => {
  assert.equal(readLab(mk({ "final_result.json": { verdict: "INSUFFICIENT_SAMPLE", trades: 12 } })).state, "REJECTED_INSUFFICIENT_SAMPLE");
  const r = readLab(mk({ "validation_result.json": "{not json", "trials.jsonl": trial(1, "lr") + "garbage\n" }));
  assert.equal(r.state, "UNREADABLE"); assert.ok(r.errors.length >= 1); assert.equal(r.trials.count, 1); assert.equal(CAP, 40);
});
test("monitor: registry and jobs show the research state read-only and stay UNAVAILABLE when nothing was run", () => {
  const { Monitor } = require("../server/monitor");
  const mon = Object.create(Monitor.prototype);
  mon.labDir = mk({ "trials.jsonl": trial(1, "lr") + trial(2, "legacy_lr"), "validation_result.json": { selected: null, reason: "REJECTED_ON_VALIDATION: none" }, "loop_state.json": { state: "IDLE", last_tick_utc: "2026-11-17T00:00:00Z", last_outcome: "SKIPPED_STRESS" } });
  const reg = mon.registry(), jobs = mon.jobs();
  assert.equal(reg.research.state, "REJECTED_ON_VALIDATION"); assert.deepEqual(reg.models, []); assert.equal(jobs.training_backend, "LOCAL_BATCH"); assert.equal(jobs.jobs[0].last_outcome, "SKIPPED_STRESS"); assert.match(jobs.note, /nothing here changes a trading policy/);
  mon.labDir = "/nonexistent-lab-dir"; assert.equal(mon.jobs().training_backend, "UNAVAILABLE");
});
test("lab registry: follow-up experiments in v2A/v2B subdirectories are listed separately with their own state", () => {
  const d = mk({ "trials.jsonl": trial(1, "lr"), "validation_result.json": { selected: null, reason: "REJECTED_ON_VALIDATION: none" } });
  for (const [n, f] of [["v2A", { selected: null, reason: "REJECTED_ON_VALIDATION: none", val_base_logloss: 0.67 }], ["v2B", { selected: { family: "hgb", params: {}, theta: 0.5 } }]]) { fs.mkdirSync(path.join(d, n)); fs.writeFileSync(path.join(d, n, "validation_result.json"), JSON.stringify(f)); fs.writeFileSync(path.join(d, n, "trials.jsonl"), trial(1, "lr") + trial(2, "hgb")); }
  fs.mkdirSync(path.join(d, "not-an-experiment")); const r = readLab(d);
  assert.deepEqual(r.experiments.map(e => e.id), ["v2A", "v2B"]); assert.equal(r.experiments[0].state, "REJECTED_ON_VALIDATION"); assert.equal(r.experiments[1].state, "SELECTED_ON_VALIDATION_FINAL_NOT_SCORED"); assert.equal(r.experiments[0].trials.count, 2); assert.equal(r.state, "REJECTED_ON_VALIDATION", "the v1 verdict is not replaced by a follow-up");
  assert.equal(r.experiments[1].models[0].promoted, false);
});
