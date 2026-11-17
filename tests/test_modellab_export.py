"""Train/serve parity: the JSON export of a fitted logistic model, scored by JavaScript, must equal Python's predict_proba. The fixture is committed and regenerated here to catch drift."""
import json, os, subprocess, shutil
import numpy as np
from modellab import fit, synthetic, data

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "tests_js", "fixtures", "modellab", "logistic_parity.json")


def build(tmp):
    synthetic.make(str(tmp), planted=True, days=200, seed=9)
    df, manifest, _ = data.load(str(tmp))
    tr = df[df["split"] == "train"]
    m = fit.Model("lr", {"C": 0.1}, manifest["features"]).fit(tr, tr["y"].to_numpy())
    sample = df[df["split"] == "validation"].head(40)
    p = m.predict(sample)
    return {"model": m.export_lr(), "rows": sample[m.cols].to_dict(orient="records"), "expected": p.tolist()}


def test_fixture_matches_current_python_output(tmp_path):
    fx = build(tmp_path)
    old = json.load(open(FIXTURE))
    assert np.allclose(old["expected"], fx["expected"], atol=1e-9) and old["model"]["features"] == fx["model"]["features"]
    assert np.allclose(old["model"]["coef"], fx["model"]["coef"], atol=1e-9)


def test_export_refuses_non_logistic_models():
    import pytest
    with pytest.raises(ValueError):
        fit.Model("hgb", {"max_depth": 2, "max_iter": 5, "min_samples_leaf": 5, "learning_rate": .1}, synthetic.FEATURES).export_lr()


def test_js_scoring_equals_python(tmp_path):
    if shutil.which("node") is None:
        import pytest; pytest.skip("node not installed")
    out = subprocess.run(["node", "-e", "const f=require(process.argv[1]),{scoreLogistic}=require('./research/score_model');console.log(JSON.stringify(f.rows.map(r=>scoreLogistic(f.model,r))))", os.path.abspath(FIXTURE)],
                         cwd=os.path.join(os.path.dirname(__file__), ".."), capture_output=True, text=True, check=True).stdout
    js = json.loads(out)
    exp = json.load(open(FIXTURE))["expected"]
    assert len(js) == len(exp) == 40 and max(abs(a - b) for a, b in zip(js, exp)) < 1e-9
