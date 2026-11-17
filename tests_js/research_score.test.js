"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { scoreLogistic } = require("../research/score_model"), fx = require("./fixtures/modellab/logistic_parity.json");
test("JS scoring of the exported logistic model equals the Python probabilities (1e-9)", () => {
  assert.equal(fx.rows.length, 40);
  fx.rows.forEach((r, k) => assert.ok(Math.abs(scoreLogistic(fx.model, r) - fx.expected[k]) < 1e-9, `row ${k}`));
});
test("scoring refuses missing features, unknown kinds and malformed models", () => {
  const r = { ...fx.rows[0] }; delete r[fx.model.features[0]];
  assert.throws(() => scoreLogistic(fx.model, r), /missing/); assert.throws(() => scoreLogistic({ ...fx.model, kind: "tree" }, fx.rows[0]), /unsupported/);
  assert.throws(() => scoreLogistic({ ...fx.model, coef: fx.model.coef.slice(1) }, fx.rows[0]), /malformed/);
});
