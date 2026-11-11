"""SYNTHETIC data for plumbing tests ONLY. Results on this data say nothing about any edge.

  python -m bgbot.synthetic --out data/synthetic --days 730
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd


def make(out: Path, days: int = 730, seed: int = 1) -> None:
    rng = np.random.default_rng(seed)
    n = days * 24
    ts = (pd.Timestamp("2024-01-01", tz="UTC") + pd.to_timedelta(np.arange(n), unit="h"))
    ms = np.asarray((ts - pd.Timestamp(0, tz="UTC")) // pd.Timedelta("1ms"), dtype="int64")
    common = rng.standard_t(4, n) * 0.004                       # fat-tailed shared factor
    out.mkdir(parents=True, exist_ok=True)
    for sym, p0, beta, idio in (("BTCUSDT", 40000, 1.0, 0.002), ("ETHUSDT", 2500, 1.2, 0.003),
                                ("XRPUSDT", 0.6, 1.4, 0.005)):
        r = beta * common + rng.standard_t(4, n) * idio
        close = p0 * np.exp(np.cumsum(r))
        open_ = np.concatenate([[p0], close[:-1]])
        wig = np.abs(rng.normal(0, idio + 0.002, n))
        high = np.maximum(open_, close) * (1 + wig)
        low = np.minimum(open_, close) * (1 - wig)
        df = pd.DataFrame({"ts": ms, "open": open_, "high": high, "low": low, "close": close,
                           "base_vol": 1.0, "quote_vol": close})
        df.to_csv(out / f"{sym}_1H_trade.csv", index=False)
        mk = df.copy()
        mk[["high", "low"]] = df[["high", "low"]].values * np.array([0.9998, 1.0002])
        mk.to_csv(out / f"{sym}_1H_mark.csv", index=False)
        f = df[df.ts % (8 * 3_600_000) == 0][["ts"]].copy()
        f["rate"] = rng.normal(0.0001, 0.0002, len(f))
        f.to_csv(out / f"{sym}_funding.csv", index=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/synthetic")
    ap.add_argument("--days", type=int, default=730)
    a = ap.parse_args()
    make(Path(a.out), a.days)
    print(f"SYNTHETIC data written to {a.out} (for plumbing tests only)")
