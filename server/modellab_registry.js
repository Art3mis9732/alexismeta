"use strict";
/* Read-only view of the research registry (research/registry): trials, validation result, the one-time FINAL result, and the bounded loop's state.
 * Presentation only: it never starts a job, never fits, never promotes. A missing directory means "no research run", not an error. Anything unreadable is reported as UNREADABLE with the reason. */
const fs = require("node:fs"), path = require("node:path");
const CAP = 40, DEFAULT_DIR = process.env.ALEXIS_LAB_DIR !== undefined ? process.env.ALEXIS_LAB_DIR : path.join(__dirname, "..", "research", "registry");
const readJson = (f) => { try { return { ok: true, v: JSON.parse(fs.readFileSync(f, "utf8")) }; } catch (e) { return e.code === "ENOENT" ? { ok: false, missing: true } : { ok: false, error: String(e.message).slice(0, 120) }; } };

function readLab(dir = DEFAULT_DIR) {
  const out = { preregistration: "research-prereg-v1", dir_present: !!dir && fs.existsSync(dir), state: "NO_RESEARCH_RUN", headline: "No model has been trained or evaluated yet.", trials: { count: 0, cap: CAP, by_family: {} }, validation: null, final: null, loop: null, models: [], promoted: false, errors: [] };
  if (!out.dir_present) return out;
  try {
    const tf = path.join(dir, "trials.jsonl");
    if (fs.existsSync(tf)) for (const line of fs.readFileSync(tf, "utf8").split("\n")) { if (!line.trim()) continue; try { const r = JSON.parse(line); out.trials.count++; if (r.kind === "config") out.trials.by_family[r.family] = (out.trials.by_family[r.family] || 0) + 1; } catch (e) { out.errors.push("unreadable trial line"); } }
  } catch (e) { out.errors.push("trials: " + String(e.message).slice(0, 80)); }
  const v = readJson(path.join(dir, "validation_result.json")), f = readJson(path.join(dir, "final_result.json")), l = readJson(path.join(dir, "loop_state.json"));
  for (const [k, r] of [["validation", v], ["final", f], ["loop", l]]) if (!r.ok && !r.missing) out.errors.push(`${k}: ${r.error}`);
  if (v.ok) out.validation = { base_logloss: v.v.val_base_logloss, selected: v.v.selected || null, reason: v.v.reason || null, control: v.v.control || null, config_trials: v.v.n_config_trials };
  if (f.ok) out.final = { verdict: f.v.verdict, trades: f.v.trades, mean_R: f.v.mean_R ?? null, ci: f.v.ci || null, criteria: f.v.criteria || {}, random_matched: f.v.random_matched || null, by_coin: f.v.by_coin || null, selected: f.v.selected || null, final_logloss: f.v.final_logloss ?? null, final_base_logloss: f.v.final_base_logloss ?? null };
  if (l.ok) out.loop = l.v;
  if (out.errors.length && !out.validation && !out.final) { out.state = "UNREADABLE"; out.headline = "The research registry could not be read: " + out.errors[0]; return out; }
  if (out.final) {
    const pass = out.final.verdict === "PASS_CANDIDATE_FOR_SHADOW";
    out.state = pass ? "CANDIDATE_FOR_SHADOW_NOT_PROMOTED" : out.final.verdict === "INSUFFICIENT_SAMPLE" ? "REJECTED_INSUFFICIENT_SAMPLE" : "REJECTED";
    out.headline = pass ? "A model cleared the pre-registered gate on the final segment. It is a candidate for forward shadow evaluation only: it is not promoted and places no trade."
      : "The model selected on validation did NOT clear the pre-registered gate on the final segment. No model is promoted.";
    if (out.final.selected) out.models.push({ id: `${out.preregistration}/${out.final.selected.family}`, family: out.final.selected.family, params: out.final.selected.params, state: out.state, edge: pass ? "CLEARED_FINAL_GATE_AWAITING_FORWARD_SHADOW" : "NOT_DEMONSTRATED", promoted: false });
  } else if (out.validation) {
    out.state = out.validation.selected ? "SELECTED_ON_VALIDATION_FINAL_NOT_SCORED" : "REJECTED_ON_VALIDATION";
    out.headline = out.validation.selected ? "A configuration was selected on validation. The final segment has not been scored yet."
      : "Rejected on validation: no configuration gave a positive after-cost result with enough trades. The final segment was never read.";
    if (out.validation.selected) out.models.push({ id: `${out.preregistration}/${out.validation.selected.family}`, family: out.validation.selected.family, params: out.validation.selected.params, state: out.state, edge: "NOT_DEMONSTRATED", promoted: false });
  } else if (out.trials.count) { out.state = "TRIALS_LOGGED_NO_RESULT"; out.headline = "Trials were logged but no validation result exists."; }
  return out;
}
module.exports = { readLab, CAP, DEFAULT_DIR };
