"""Load downloaded CSVs, resample to signal bars, attach mark-price extremes and funding."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .config import ROOT

RAW = ROOT / "data" / "raw"


def _load(fn: Path) -> pd.DataFrame:
    df = pd.read_csv(fn)
    df.index = pd.to_datetime(df.pop("ts"), unit="ms", utc=True)
    return df


def resample_ohlc(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """UTC-aligned bars. A bar is dropped if any of its 1H inputs are missing (no forward fill)."""
    r = rule.replace("H", "h")
    g = df.resample(r, origin="epoch", label="left", closed="left")
    agg = g.agg({"open": "first", "high": "max", "low": "min", "close": "last"})
    cnt = g["close"].count()
    step = df.index.to_series().diff().median()
    expected = int(pd.Timedelta(r) / step)
    return agg[cnt == expected]


def load_symbol(symbol: str, signal_bar: str = "4H", gran: str = "1H", raw_dir: Path = RAW) -> pd.DataFrame:
    """Returns signal bars with columns:
    open high low close  (trade prices)
    mark_high mark_low   (mark-price extremes, for liquidation checks; NaN if unavailable)
    funding              (sum of funding rates settled AT this bar's open timestamp; 0 if none)
    """
    trade = _load(raw_dir / f"{symbol}_{gran}_trade.csv")
    bars = resample_ohlc(trade[["open", "high", "low", "close"]], signal_bar)
    mark_fn = raw_dir / f"{symbol}_{gran}_mark.csv"
    if mark_fn.exists():
        mark = _load(mark_fn)
        mb = resample_ohlc(mark[["open", "high", "low", "close"]], signal_bar)
        bars["mark_high"] = mb["high"].reindex(bars.index)
        bars["mark_low"] = mb["low"].reindex(bars.index)
    else:
        bars["mark_high"] = float("nan"); bars["mark_low"] = float("nan")
    fund_fn = raw_dir / f"{symbol}_funding.csv"
    bars["funding"] = 0.0
    if fund_fn.exists():
        f = _load(fund_fn)
        # Settlement at time s is charged to positions open at s. 8h settlements (00/08/16 UTC)
        # fall exactly on 4H bar opens. If an interval is shorter (e.g. 1h), settlements inside a
        # bar are mapped to that bar's open - an approximation that charges slightly early.
        r = signal_bar.replace("H", "h")
        on_boundary = bool((f.index == f.index.floor(r)).all())
        f.index = f.index.floor(r)
        fs = f["rate"].groupby(level=0).sum()
        bars["funding"] = fs.reindex(bars.index).fillna(0.0)
        bars.attrs["funding_on_bar_boundaries"] = on_boundary
    return bars


def load_universe(symbols: list[str], signal_bar: str = "4H", raw_dir: Path = RAW) -> dict[str, pd.DataFrame]:
    return {s: load_symbol(s, signal_bar, raw_dir=raw_dir) for s in symbols}
