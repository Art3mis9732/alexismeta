"""Model Lab pipeline tests on SYNTHETIC datasets: the machinery must reject pure noise and find a planted signal, refuse tampered data, and refuse a second look at FINAL."""
import json, os, gzip
import numpy as np
import pandas as pd
import pytest
from modellab import evalkit, synthetic, fit, final, data


@pytest.fixture(scope="module")
def noise_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("noise")
    synthetic.make(str(d), planted=False)
    return str(d)


@pytest.fixture(scope="module")
def planted_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("planted")
    synthetic.make(str(d), planted=True)
    return str(d)


def test_noise_is_rejected_end_to_end(noise_dir, tmp_path):
    reg = str(tmp_path / "reg")
    out = fit.run_validation(noise_dir, reg)
    assert out["control"]["val_gain_vs_base_with_shuffled_train_labels"] < 0.002
    if out["selected"]:                                    # if luck selected something on validation, FINAL must still reject it
        res = final.score_final(noise_dir, reg, seeds=40)
        assert res["verdict"] != "PASS_CANDIDATE_FOR_SHADOW"
    else:
        assert out["reason"].startswith("REJECTED_ON_VALIDATION")
        with pytest.raises(RuntimeError):
            final.score_final(noise_dir, reg)


def test_planted_signal_is_found_and_passes_the_gate(planted_dir, tmp_path):
    reg = str(tmp_path / "reg")
    out = fit.run_validation(planted_dir, reg)
    assert out["selected"] is not None and out["selected"]["val_mean_R"] > 0
    res = final.score_final(planted_dir, reg, seeds=60)
    assert res["verdict"] == "PASS_CANDIDATE_FOR_SHADOW", json.dumps({k: res.get(k) for k in ("verdict", "trades", "mean_R", "criteria", "ci")})
    assert res["criteria"]["3_beats_random_p95"] and res["ci"]["lo"] > 0
    with pytest.raises(RuntimeError, match="already scored"):
        final.score_final(planted_dir, reg)                # FINAL is scored exactly once


def test_trial_log_counts_every_trial_and_is_capped(planted_dir, tmp_path):
    reg = str(tmp_path / "reg")
    fit.run_validation(planted_dir, reg)
    lines = [json.loads(l) for l in open(os.path.join(reg, "trials.jsonl"))]
    assert len(lines) == len(fit.specs()) + len(fit.THETAS) and len(lines) <= fit.TRIAL_CAP
    assert [r["trial_id"] for r in lines] == list(range(1, len(lines) + 1))
    with open(os.path.join(reg, "trials.jsonl"), "a") as f:
        for _ in range(fit.TRIAL_CAP - len(lines)):
            f.write("{}\n")
    with pytest.raises(RuntimeError, match="trial cap"):
        fit.log_trial(os.path.join(reg, "trials.jsonl"), {})


def test_tampered_dataset_is_refused(planted_dir, tmp_path):
    import shutil
    d = str(tmp_path / "t")
    shutil.copytree(planted_dir, d)
    raw = gzip.open(os.path.join(d, "rows.csv.gz"), "rb").read().decode().splitlines()
    raw[5] = raw[5].replace(",1,", ",0,", 1)
    gzip.open(os.path.join(d, "rows.csv.gz"), "wb").write(("\n".join(raw) + "\n").encode())
    with pytest.raises(ValueError, match="hash"):
        data.load(d)


def test_validation_stage_never_reads_final_rows(planted_dir, tmp_path, monkeypatch):
    seen = []
    orig = fit.Model.fit
    def spy(self, df, y):
        seen.append(set(df["split"].unique()))
        return orig(self, df, y)
    monkeypatch.setattr(fit.Model, "fit", spy)
    fit.run_validation(planted_dir, str(tmp_path / "reg"), shuffle_control=False)
    assert seen and all(s == {"train"} for s in seen)


def test_select_trades_one_position_per_coin_and_best_side():
    ts0 = 1_700_000_000_000
    df = pd.DataFrame({"ts": [ts0, ts0, ts0 + 900_000, ts0 + 900_000, ts0 + 9_000_000, ts0 + 9_000_000], "coin": ["A"] * 6, "side": [1, -1] * 3,
                       "netR": [1.0, -1.0, 2.0, -2.0, 3.0, -3.0], "costR": [0.3] * 6, "bars_held": [4.0] * 6})
    p = np.array([0.7, 0.4, 0.9, 0.1, 0.1, 0.8])
    tr = evalkit.select_trades(df, p, 0.5)
    assert list(tr["netR"]) == [1.0, -3.0]                  # bar 2 is skipped (position open for 4 bars); bar 3 takes the short because it has the higher p


def test_gate_requires_enough_trades_and_ci_is_deterministic():
    df = pd.DataFrame({"ts": np.arange(50) * 900_000 * 10 + 1_700_000_000_000, "coin": "A", "side": 1, "netR": 1.0, "costR": 0.3, "bars_held": 1.0})
    assert evalkit.gate(df, np.full(50, 0.9), 0.5)["verdict"] == "INSUFFICIENT_SAMPLE"
    a = evalkit.day_block_ci(df["ts"], df["netR"], B=300, seed=2)
    assert a == evalkit.day_block_ci(df["ts"], df["netR"], B=300, seed=2)


def test_legacy_subset_is_a_subset_of_the_dataset_features():
    assert set(fit.LEGACY_SUBSET) <= set(synthetic.FEATURES)


def _final_df(coin_means, n=400, sd=1.0, cost=0.3, seed=1):
    rng = np.random.default_rng(seed)
    rows = []
    t0 = 1_700_000_000_000
    for c, m in coin_means.items():
        ts = t0 + np.arange(n) * 900_000 * 12 + (hash(c) % 7) * 1000
        rows.append(pd.DataFrame({"ts": ts, "coin": c, "side": 1, "netR": rng.normal(m, sd, n), "costR": cost, "bars_held": 1.0}))
    return pd.concat(rows, ignore_index=True)


def test_gate_each_criterion_can_fail():
    p = lambda df: np.full(len(df), 0.9)
    # clearly good everywhere -> pass
    df = _final_df({"A": 0.4, "B": 0.4, "C": 0.4}, sd=0.3)
    df["netR"] += np.random.default_rng(5).normal(0, 0.0, len(df))
    # the matched random baseline draws from the SAME rows, so a uniform-quality pool can never beat its own p95
    assert evalkit.gate(df, p(df), 0.5, seeds=40)["criteria"]["3_beats_random_p95"] is False
    # tiny noisy edge: CI lower bound below zero
    df = _final_df({"A": 0.03, "B": 0.03, "C": 0.03}, sd=1.5)
    r = evalkit.gate(df, p(df), 0.5, seeds=40)
    assert r["criteria"]["2_ci_lower_gt_0"] is False and r["verdict"] == "REJECTED"
    # one coin carries the result: stability fails
    df = _final_df({"A": 1.5, "B": -0.05, "C": -0.05}, sd=0.5)
    r = evalkit.gate(df, p(df), 0.5, seeds=40)
    assert r["criteria"]["4_stable"] is False and r["verdict"] == "REJECTED"
    # positive only if costs stay as modelled: +25% costs flips it
    df = _final_df({"A": 0.1, "B": 0.1, "C": 0.1}, sd=0.2, cost=1.0)
    r = evalkit.gate(df, p(df), 0.5, seeds=40)
    assert r["criteria"]["5_costs_plus_25pct_positive"] is False and r["verdict"] == "REJECTED"


def test_gate_passes_when_the_model_truly_separates_good_rows():
    rng = np.random.default_rng(2)
    n = 6000
    ts = 1_700_000_000_000 + np.arange(n) * 900_000 * 4
    good = rng.random(n) < 0.15
    df = pd.DataFrame({"ts": ts, "coin": np.array(["A", "B", "C"])[np.arange(n) % 3], "side": 1, "netR": np.where(good, 1.2, -0.5) + rng.normal(0, 0.1, n), "costR": 0.3, "bars_held": 1.0})
    p = np.where(good, 0.9, 0.1)
    r = evalkit.gate(df, p, 0.5, seeds=60)
    assert r["verdict"] == "PASS_CANDIDATE_FOR_SHADOW", r
