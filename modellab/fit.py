"""Validation-stage fitting for research-prereg-v1. FINAL rows are never read here. Every trial (including bad ones) is appended to the trial log; the total is capped."""
from __future__ import annotations
import datetime as dt, json, os
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from . import evalkit, data

TRIAL_CAP = 40
THETAS = [0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.64, 0.66, 0.68, 0.70]
MIN_GAIN = 0.0005                      # a model must beat the training base rate's log loss on VALIDATION by this much to be considered at all
MIN_VAL_TRADES = 100
LEGACY_SUBSET = ["ret1", "ret4", "ret16", "ret96", "vol_ratio", "atr_pct", "hour_sin", "hour_cos"]   # momentum / volatility / volume / time of day: the legacy model's family (no triggers, trend or VWAP)


def specs():
    out = [{"family": "constant", "params": {}}]
    out += [{"family": "legacy_lr", "params": {"C": c}} for c in (0.01, 0.1, 1.0)]
    out += [{"family": "lr", "params": {"C": c}} for c in (0.001, 0.01, 0.1, 1.0, 10.0)]
    out += [{"family": "hgb", "params": {"max_depth": d, "max_iter": it, "min_samples_leaf": leaf, "learning_rate": 0.05}} for d in (2, 3) for it in (50, 100, 200) for leaf in (500, 2000)]
    return out


class Model:
    def __init__(self, family, params, features):
        self.family, self.params, self.features = family, params, features
        self.cols = LEGACY_SUBSET if family == "legacy_lr" else features

    def fit(self, df, y):
        if self.family == "constant":
            self.base = float(np.mean(y))
            return self
        X = df[self.cols].to_numpy(float)
        if self.family in ("lr", "legacy_lr"):
            self.scaler = StandardScaler().fit(X)
            self.m = LogisticRegression(C=self.params["C"], max_iter=1000).fit(self.scaler.transform(X), y)
        else:
            self.m = HistGradientBoostingClassifier(early_stopping=False, random_state=0, l2_regularization=1.0, **self.params).fit(X, y)
        return self

    def predict(self, df):
        if self.family == "constant":
            return np.full(len(df), self.base)
        X = df[self.cols].to_numpy(float)
        if self.family in ("lr", "legacy_lr"):
            X = self.scaler.transform(X)
        return self.m.predict_proba(X)[:, 1]

    def export_lr(self):
        if self.family not in ("lr", "legacy_lr"):
            raise ValueError("only logistic regression has a JSON exporter")
        return {"kind": "logistic-v1", "features": self.cols, "mean": self.scaler.mean_.tolist(), "std": self.scaler.scale_.tolist(), "coef": self.m.coef_[0].tolist(), "intercept": float(self.m.intercept_[0])}


def _count(path):
    return sum(1 for _ in open(path)) if os.path.exists(path) else 0


def log_trial(path, rec):
    if _count(path) >= TRIAL_CAP:
        raise RuntimeError(f"trial cap {TRIAL_CAP} reached: a new pre-registration version is required")
    rec = {"trial_id": _count(path) + 1, "utc": dt.datetime.now(dt.timezone.utc).isoformat(), "sklearn": sklearn.__version__, **rec}
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def run_validation(dataset_dir: str, registry_dir: str, shuffle_control=True):
    df, manifest, split = data.load(dataset_dir)
    prev = os.path.join(registry_dir, "validation_result.json")
    if os.path.exists(prev) and json.load(open(prev)).get("matrix_sha256") == manifest["matrix_sha256"]:
        raise RuntimeError("validation was already run for this dataset: a second run would spend more of the trial budget. A new dataset needs a new pre-registration version.")
    feats = manifest["features"]
    tr, va = df[df["split"] == "train"], df[df["split"] == "validation"]            # FINAL rows are not touched
    os.makedirs(registry_dir, exist_ok=True)
    trials = os.path.join(registry_dir, "trials.jsonl")
    base = float(tr["y"].mean())
    base_ll = evalkit.logloss(va["y"], np.full(len(va), base))
    common = {"stage": "validation", "matrix_sha256": manifest["matrix_sha256"], "split": split["iso"], "n_train": int(len(tr)), "n_validation": int(len(va)), "val_base_logloss": base_ll}
    results = []
    for sp in specs():
        m = Model(sp["family"], sp["params"], feats).fit(tr, tr["y"].to_numpy())
        p = m.predict(va)
        ll = evalkit.logloss(va["y"], p)
        rec = log_trial(trials, {**common, "kind": "config", **sp, "val_logloss": ll, "val_brier": evalkit.brier(va["y"], p), "val_gain_vs_base": base_ll - ll})
        results.append((rec, m))
    control = None
    if shuffle_control:
        rng = np.random.default_rng(11)
        ys = rng.permutation(tr["y"].to_numpy())
        m = Model("lr", {"C": 1.0}, feats).fit(tr, ys)
        control = {"val_gain_vs_base_with_shuffled_train_labels": base_ll - evalkit.logloss(va["y"], m.predict(va)), "note": "should be about 0; a clearly positive value would mean leakage"}
    cands = [(r, m) for r, m in results if r["family"] != "constant" and r["val_gain_vs_base"] >= MIN_GAIN]
    out = {"matrix_sha256": manifest["matrix_sha256"], "val_base_logloss": base_ll, "control": control, "n_config_trials": len(results), "selected": None}
    if not cands:
        out["reason"] = "REJECTED_ON_VALIDATION: no configuration beat the base rate's log loss by the minimum margin"
    else:
        rec, m = min(cands, key=lambda rm: rm[0]["val_logloss"])
        p = m.predict(va)
        best = None
        for th in THETAS:
            tr_sel = evalkit.select_trades(va, p, th)
            r = float(tr_sel["netR"].mean()) if len(tr_sel) else None
            log_trial(trials, {**common, "kind": "threshold", "family": rec["family"], "params": rec["params"], "of_trial": rec["trial_id"], "theta": th, "val_trades": int(len(tr_sel)), "val_mean_R": r})
            if len(tr_sel) >= MIN_VAL_TRADES and r is not None and (best is None or r > best[1]):
                best = (th, r, len(tr_sel))
        if best is None or best[1] <= 0:
            out["reason"] = "REJECTED_ON_VALIDATION: no threshold gives a positive mean R per trade with enough validation trades (FINAL not touched)"
            out["best_threshold"] = best
        else:
            out["selected"] = {"family": rec["family"], "params": rec["params"], "trial_id": rec["trial_id"], "theta": best[0], "val_mean_R": best[1], "val_trades": best[2]}
    with open(os.path.join(registry_dir, "validation_result.json"), "w") as f:
        json.dump(out, f, indent=1)
    return out
