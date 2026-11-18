"use strict";
/* Serving-side scoring of an exported model. Only JSON-exportable models can be served (logistic-v1 today); a model without an exporter cannot enter shadow evaluation.
 * Parity with the Python fit is tested against a committed fixture (tests_js/fixtures/modellab/logistic_parity.json, regenerated and compared by tests/test_modellab_export.py). */
function scoreLogistic(model, featureValues) {
  if (!model || model.kind !== "logistic-v1") throw new Error("unsupported model kind");
  if (model.features.length !== model.coef.length || model.mean.length !== model.coef.length || model.std.length !== model.coef.length) throw new Error("malformed model");
  let z = model.intercept;
  for (let k = 0; k < model.features.length; k++) {
    const v = featureValues[model.features[k]]; if (!Number.isFinite(v)) throw new Error("missing or non-finite feature " + model.features[k]);
    z += model.coef[k] * (v - model.mean[k]) / (model.std[k] || 1);
  }
  return 1 / (1 + Math.exp(-z));
}
module.exports = { scoreLogistic };
