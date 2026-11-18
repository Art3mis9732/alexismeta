"""The one-time FINAL scoring. Refuses to run twice, refuses if nothing was selected on validation, refuses if the dataset no longer matches its manifest."""
from __future__ import annotations
import json, os
from . import evalkit, data, fit


def score_final(dataset_dir: str, registry_dir: str, seeds=200):
    sel_path = os.path.join(registry_dir, "validation_result.json")
    lock = os.path.join(registry_dir, "final_scored.lock")
    if os.path.exists(lock):
        raise RuntimeError("FINAL was already scored once; a new pre-registration version and a new final segment are required")
    sel = json.load(open(sel_path))
    if not sel.get("selected"):
        raise RuntimeError("nothing was selected on validation: FINAL stays untouched")
    df, manifest, _ = data.load(dataset_dir)
    if manifest["matrix_sha256"] != sel["matrix_sha256"]:
        raise RuntimeError("dataset changed since validation")
    reg = os.path.join(registry_dir, "dataset-v1-manifest.json")                    # the committed copy of the registered manifest, when the registry holds one
    if os.path.exists(reg) and json.load(open(reg))["matrix_sha256"] != manifest["matrix_sha256"]:
        raise RuntimeError("dataset does not match the registered manifest")
    s = sel["selected"]
    tr, fi = df[df["split"] == "train"], df[df["split"] == "final"]
    m = fit.Model(s["family"], s["params"], manifest["features"]).fit(tr, tr["y"].to_numpy())
    p = m.predict(fi)
    res = evalkit.gate(fi, p, s["theta"], seeds=seeds)
    res.update(selected=s, final_logloss=evalkit.logloss(fi["y"], p), final_base_logloss=evalkit.logloss(fi["y"], [tr["y"].mean()] * len(fi)), final_brier=evalkit.brier(fi["y"], p), matrix_sha256=manifest["matrix_sha256"])
    open(lock, "w").write(res["verdict"] + "\n")
    with open(os.path.join(registry_dir, "final_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    return res
