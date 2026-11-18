"""python -m modellab.audit [--dataset DIR] [--out FILE]: diagnosis of the 21 validation-stage configurations (research-prereg-v1). TRAIN and VALIDATION rows only; FINAL is never read.
For every configuration: what it is, what it predicted, and how much gross (frictionless) and net result sits in its most confident rows. Plus the cost decomposition of the template trade."""
import argparse, json
import numpy as np
from . import data, fit, evalkit


def run(dataset_dir="data/research/dataset-v1", registry="research/registry"):
    df, manifest, split = data.load(dataset_dir)
    tr, va = df[df["split"] == "train"], df[df["split"] == "validation"]
    out = {"matrix_sha256": manifest["matrix_sha256"], "split": split["iso"], "template": manifest["template"], "features": manifest["features"], "target": "y = 1 if the template trade nets > 0 after costs", "rows": {"train": int(len(tr)), "validation": int(len(va))}}
    for name, d in (("train", tr), ("validation", va)):
        gross = d["netR"] + d["costR"]
        fee_R = 0.12 / d["atr_pct"]                                     # taker 6 bps per leg = 12 bps round trip, in R (ATR% is in percent); approximate: ignores the small exit-price drift
        out[f"cost_decomposition_{name}"] = {"mean_netR": float(d["netR"].mean()), "mean_gross_R_frictionless": float(gross.mean()), "mean_costR": float(d["costR"].mean()), "mean_fee_R_approx": float(fee_R.mean()),
            "mean_slippage_and_other_R_approx": float((d["costR"] - fee_R).mean()), "median_costR": float(d["costR"].median()), "win_rate_after_costs": float(d["y"].mean()), "target_before_stop_rate": float((d["reason"] == "target").mean()),
            "breakeven_win_probability_at_mean_cost": float((1 + d["costR"].mean()) / (1.5 + 1.0)), "gross_R_by_costR_bin": {}}
        d2 = d.assign(cb=np.digitize(d["costR"], [0.2, 0.35, 0.5, 0.8, 1.2]), g=gross)
        out[f"cost_decomposition_{name}"]["gross_R_by_costR_bin"] = {str(int(k)): {"n": int(len(g)), "mean_costR": float(g["costR"].mean()), "mean_gross_R": float(g["g"].mean()), "mean_netR": float(g["netR"].mean()), "win_rate": float(g["y"].mean())} for k, g in d2.groupby("cb")}
    base = float(tr["y"].mean())
    base_ll = evalkit.logloss(va["y"], np.full(len(va), base))
    models = []
    for sp in fit.specs():
        m = fit.Model(sp["family"], sp["params"], manifest["features"]).fit(tr, tr["y"].to_numpy())
        p = m.predict(va)
        gross = (va["netR"] + va["costR"]).to_numpy()
        rec = {"family": sp["family"], "params": sp["params"], "features_used": m.cols if sp["family"] != "constant" else [], "val_logloss": evalkit.logloss(va["y"], p), "val_gain_vs_base": base_ll - evalkit.logloss(va["y"], p),
               "val_brier": evalkit.brier(va["y"], p), "pred_p_min_median_max": [float(p.min()), float(np.median(p)), float(p.max())], "rows_with_p_ge_0.50": int((p >= 0.5).sum())}
        if sp["family"] != "constant" and np.ptp(p) > 0:
            for q in (0.5, 0.9, 0.99):
                idx = p >= np.quantile(p, q)
                rec[f"top_{round((1 - q) * 100)}pct"] = {"n": int(idx.sum()), "mean_netR": float(va["netR"].to_numpy()[idx].mean()), "mean_gross_R": float(gross[idx].mean()), "mean_costR": float(va["costR"].to_numpy()[idx].mean()), "win_rate": float(va["y"].to_numpy()[idx].mean())}
            rec["corr_p_with_costR"] = float(np.corrcoef(p, va["costR"])[0, 1])
            rec["corr_p_with_gross_R"] = float(np.corrcoef(p, gross)[0, 1])
        models.append(rec)
    out["models"] = models
    out["verdict_inputs"] = {"best_val_gain": max(m["val_gain_vs_base"] for m in models), "max_gross_R_in_any_top_1pct": max((m.get("top_1pct", {}).get("mean_gross_R", -9) for m in models)), "min_cost_R_in_cheapest_bin_mean": out["cost_decomposition_validation"]["gross_R_by_costR_bin"]["0"]["mean_costR"]}
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="data/research/dataset-v1")
    ap.add_argument("--out", default="devdocs/evidence/model-audit-2026-11-18.json")
    a = ap.parse_args()
    r = run(a.dataset)
    json.dump(r, open(a.out, "w"), indent=1)
    print(json.dumps({"verdict_inputs": r["verdict_inputs"], "train": {k: r["cost_decomposition_train"][k] for k in ("mean_netR", "mean_gross_R_frictionless", "mean_costR", "mean_fee_R_approx", "mean_slippage_and_other_R_approx", "win_rate_after_costs", "target_before_stop_rate", "breakeven_win_probability_at_mean_cost")},
                      "validation": {k: r["cost_decomposition_validation"][k] for k in ("mean_netR", "mean_gross_R_frictionless", "mean_costR", "win_rate_after_costs", "breakeven_win_probability_at_mean_cost")}}, indent=1))
