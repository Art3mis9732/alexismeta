"""Synthetic datasets in the research-dataset-v1 CSV layout, used only by tests: pure noise (must be REJECTED) and a planted signal (must be found)."""
from __future__ import annotations
import gzip, hashlib, json, os
import numpy as np

FEATURES = ["trend", "vwap_side", "vwap_dist_atr", "atr_pct", "atr_pctile", "chg24h", "rv24h", "trig_with", "trig_against", "trig_bo_with", "trig_retest_with", "trig_vwap_with", "trig_fail_with",
            "ret1", "ret4", "ret16", "ret96", "range_pos", "vol_ratio", "hour_sin", "hour_cos"]
DAY = 86_400_000
BAR = 900_000


def make(out_dir, planted: bool, days=420, seed=3, coins=("BTCUSDT", "ETHUSDT", "XRPUSDT")):
    rng = np.random.default_rng(seed)
    t0 = 1_700_000_000_000 // BAR * BAR
    n = days * 96
    span = n * BAR
    a = t0 + 14 * DAY
    last = t0 + span
    s = (last - a)
    tr_end, va_start, va_end, fi_start = a + s * .55, a + s * .55 + 3 * DAY, a + s * .75, a + s * .75 + 3 * DAY
    split = {"train": [a, tr_end], "validation": [va_start, va_end], "final": [fi_start, last], "iso": {}}
    rows = ["ts,coin,side,split," + ",".join(FEATURES) + ",y,netR,costR,reason,ambiguous,bars_held"]
    h = hashlib.sha256()
    for coin in coins:
        for i in range(0, n, 3):
            ts = t0 + i * BAR
            sp = "train" if a <= ts < tr_end else "validation" if va_start <= ts < va_end else "final" if fi_start <= ts < last else None
            if sp is None:
                continue
            f = rng.normal(size=len(FEATURES))
            for side in (1, -1):
                ff = f.copy() * (1 if side == 1 else 1)
                prob = 0.36 if not planted else 1 / (1 + np.exp(-(-0.6 + 1.4 * ff[0] + 0.9 * ff[1])))
                y = int(rng.random() < prob)
                cost = 0.35
                netR = (1.5 - cost) if y else (-1.0 - cost)
                held = float(rng.integers(1, 30))
                line = ",".join([str(ts), coin, str(side), sp] + [f"{v:.9g}" for v in ff] + [str(y), f"{netR:.9g}", f"{cost:.9g}", "target" if y else "stop", "0", f"{held}"])
                rows.append(line)
                h.update((line + "\n").encode())
    os.makedirs(out_dir, exist_ok=True)
    gzip.open(os.path.join(out_dir, "rows.csv.gz"), "wb").write(("\n".join(rows) + "\n").encode())
    json.dump(split, open(os.path.join(out_dir, "split.json"), "w"))
    json.dump({"features": FEATURES, "matrix_sha256": h.hexdigest()}, open(os.path.join(out_dir, "manifest.json"), "w"))
