"""Evaluation kit: probabilistic metrics, the trade-selection rule, day-block bootstrap, matched random baseline and the acceptance gate (prereg section 5).
Everything is fixed-size (1 R per trade, no compounding), so results do not depend on an account path."""
from __future__ import annotations
import numpy as np
import pandas as pd

BAR_MS = 900_000
DAY_MS = 86_400_000


def logloss(y, p, eps=1e-12):
    p = np.clip(np.asarray(p, float), eps, 1 - eps)
    y = np.asarray(y, float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p):
    return float(np.mean((np.asarray(p, float) - np.asarray(y, float)) ** 2))


def calibration(y, p, bins=10):
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & (p <= b) if b == edges[-1] else (p >= a) & (p < b)
        if m.sum():
            out.append({"p_mean": float(p[m].mean()), "y_mean": float(y[m].mean()), "n": int(m.sum())})
    return out


def select_trades(df: pd.DataFrame, p, theta: float) -> pd.DataFrame:
    """For each coin and bar take the side with the higher probability if it is >= theta; one position per coin at a time (occupied until the label exit)."""
    d = df[["ts", "coin", "side", "netR", "costR", "bars_held"]].copy()
    d["p"] = np.asarray(p, float)
    d = d.sort_values(["coin", "ts", "p"], ascending=[True, True, False]).drop_duplicates(["coin", "ts"], keep="first")
    d = d[d["p"] >= theta].sort_values(["coin", "ts"])
    keep = []
    free = {}
    for row in d.itertuples(index=True):
        if row.ts >= free.get(row.coin, -1):
            keep.append(row.Index)
            free[row.coin] = row.ts + max(row.bars_held, 1.0) * BAR_MS
    return d.loc[keep].sort_values("ts")


def day_block_ci(ts, r, B=2000, seed=1):
    """95% CI of the mean R per trade, resampling whole UTC days (trades on the same day are not independent)."""
    ts = np.asarray(ts)
    r = np.asarray(r, float)
    if len(r) == 0:
        return {"mean": None, "lo": None, "hi": None, "trades": 0, "days": 0}
    day = (ts // DAY_MS).astype(np.int64)
    days, inv = np.unique(day, return_inverse=True)
    s = np.bincount(inv, weights=r)
    n = np.bincount(inv).astype(float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(days), size=(B, len(days)))
    means = s[idx].sum(1) / np.maximum(n[idx].sum(1), 1)
    return {"mean": float(r.mean()), "lo": float(np.quantile(means, 0.025)), "hi": float(np.quantile(means, 0.975)), "trades": int(len(r)), "days": int(len(days))}


def random_matched(df: pd.DataFrame, counts: dict, seeds=200, base_seed=7, with_counts=False):
    """Mean R of random entries with the same trade count per coin, random side, the same template exits and the same one-position rule."""
    out = []
    ns = []
    pools = {}
    for coin, g in df.groupby("coin"):
        g = g.sort_values("ts")
        pools[coin] = (g["ts"].to_numpy(), g["netR"].to_numpy(), g["bars_held"].to_numpy())
    for k in range(seeds):
        rng = np.random.default_rng(base_seed + k)
        tot, n = 0.0, 0
        for coin, want in counts.items():
            if want <= 0 or coin not in pools:
                continue
            ts, r, held = pools[coin]
            # occupancy in REAL TIME (15-minute slots from the first row), so a template with hourly rows or a 24 h hold blocks exactly the slots it covers
            t0 = int(ts.min())
            slot = ((ts - t0) // BAR_MS).astype(np.int64)
            occ = np.zeros(int(slot.max()) + 400, bool)
            order = rng.permutation(len(ts))
            got = 0
            for j in order:
                i = int(slot[j])
                h = int(np.ceil(max(held[j], 1.0)))
                if occ[i:i + h].any():
                    continue
                occ[i:i + h] = True
                tot += r[j]
                n += 1
                got += 1
                if got >= want:
                    break
        out.append(tot / n if n else 0.0)
        ns.append(n)
    return (np.asarray(out), ns) if with_counts else np.asarray(out)


def gate(final_df: pd.DataFrame, p, theta: float, seeds=200, B=2000, min_trades=300):
    """Prereg section 5: all five conditions on FINAL. Returns the verdict and every number behind it."""
    tr = select_trades(final_df, p, theta)
    res = {"theta": theta, "trades": int(len(tr)), "criteria": {}}
    if len(tr) < min_trades:
        res.update(verdict="INSUFFICIENT_SAMPLE", mean_R=float(tr["netR"].mean()) if len(tr) else None)
        return res
    ci = day_block_ci(tr["ts"], tr["netR"], B=B)
    counts = tr.groupby("coin").size().to_dict()
    rnd = random_matched(final_df, counts, seeds=seeds)
    p95 = float(np.quantile(rnd, 0.95))
    by_coin = tr.groupby("coin")["netR"].mean()
    mid = tr["ts"].median()
    halves = [float(tr[tr["ts"] <= mid]["netR"].mean()), float(tr[tr["ts"] > mid]["netR"].mean())]
    stressed = float((tr["netR"] - 0.25 * tr["costR"]).mean())
    c = res["criteria"]
    c["1_min_trades"] = True
    c["2_ci_lower_gt_0"] = bool(ci["lo"] > 0)
    c["3_beats_random_p95"] = bool(ci["mean"] > p95)
    c["4_stable"] = bool((by_coin > 0).sum() >= 2 and all(h > 0 for h in halves))
    c["5_costs_plus_25pct_positive"] = bool(stressed > 0)
    res.update(mean_R=ci["mean"], ci=ci, random_matched={"p5": float(np.quantile(rnd, .05)), "p50": float(np.quantile(rnd, .5)), "p95": p95, "seeds": int(seeds)},
               by_coin={k: float(v) for k, v in by_coin.items()}, halves=halves, mean_R_costs_plus_25pct=stressed, trades_per_day=float(len(tr) / max(1, (tr["ts"].max() - tr["ts"].min()) / DAY_MS)),
               verdict="PASS_CANDIDATE_FOR_SHADOW" if all(c.values()) else "REJECTED")
    return res
