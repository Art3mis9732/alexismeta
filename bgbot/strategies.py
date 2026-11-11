"""Two pre-registered candidate strategies. Rules are fixed here BEFORE any test.

Timing contract (no look-ahead):
  * Every column is computed from bars <= t (the bar that just CLOSED).
  * The engine acts on a signal from bar t at the OPEN of bar t+1+delay.
  * Protective stops are placed at fill_price -/+ stop_dist and can trigger intrabar.

TREND (volatility-scaled breakout), 4H bars
  entry long : close_t > highest high of the previous `entry_lookback` bars (excluding t)
  entry short: close_t < lowest  low  of the previous `entry_lookback` bars
  exit long  : close_t < lowest  low  of the previous `exit_lookback` bars   (next open)
  exit short : close_t > highest high of the previous `exit_lookback` bars   (next open)
  stop       : stop_atr * ATR(atr_len) from the fill price, fixed for the trade's life
  skip       : last settled funding would charge the new position more than max_adverse_funding

MEAN REVERSION (range-only), 4H bars
  regime     : efficiency ratio ER(er_len) = |close_t - close_{t-n}| / sum|diff| < er_max
  entry long : regime and close_t < SMA(bb_len) - bb_k * SD(bb_len)
  entry short: regime and close_t > SMA(bb_len) + bb_k * SD(bb_len)
  exit       : close crosses back to SMA (long: close >= SMA; short: close <= SMA)  (next open)
  stop       : stop_atr * ATR(atr_len) from fill price
  time stop  : exit at next open after `time_stop_bars` bars in the trade
  skip       : same funding rule as trend

Sizing is NOT here - it lives in sizing.py and is shared by backtest, paper and demo.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def atr(df: pd.DataFrame, n: int) -> pd.Series:
    prev_close = df.close.shift(1)
    tr = pd.concat([df.high - df.low, (df.high - prev_close).abs(), (df.low - prev_close).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()   # Wilder smoothing


def last_settled_funding(df: pd.DataFrame) -> pd.Series:
    f = df["funding"].where(df["funding"] != 0.0)
    return f.ffill().fillna(0.0)


def trend_signals(df: pd.DataFrame, p: dict) -> pd.DataFrame:
    hh = df.high.rolling(p["entry_lookback"]).max().shift(1)
    ll = df.low.rolling(p["entry_lookback"]).min().shift(1)
    xl = df.low.rolling(p["exit_lookback"]).min().shift(1)
    xh = df.high.rolling(p["exit_lookback"]).max().shift(1)
    a = atr(df, p["atr_len"])
    fund = last_settled_funding(df)
    out = pd.DataFrame(index=df.index)
    out["entry_long"] = (df.close > hh) & (fund <= p["max_adverse_funding"])
    out["entry_short"] = (df.close < ll) & (-fund <= p["max_adverse_funding"])
    out["exit_long"] = df.close < xl
    out["exit_short"] = df.close > xh
    out["stop_dist"] = p["stop_atr"] * a
    out["time_stop"] = 0                       # none for trend
    valid = hh.notna() & a.notna()
    out.loc[~valid, ["entry_long", "entry_short"]] = False
    return out


def meanrev_signals(df: pd.DataFrame, p: dict) -> pd.DataFrame:
    n = p["bb_len"]
    ma = df.close.rolling(n).mean()
    sd = df.close.rolling(n).std(ddof=0)
    m = p["er_len"]
    er = (df.close - df.close.shift(m)).abs() / df.close.diff().abs().rolling(m).sum()
    regime = er < p["er_max"]
    a = atr(df, p["atr_len"])
    fund = last_settled_funding(df)
    out = pd.DataFrame(index=df.index)
    out["entry_long"] = regime & (df.close < ma - p["bb_k"] * sd) & (fund <= p["max_adverse_funding"])
    out["entry_short"] = regime & (df.close > ma + p["bb_k"] * sd) & (-fund <= p["max_adverse_funding"])
    out["exit_long"] = df.close >= ma
    out["exit_short"] = df.close <= ma
    out["stop_dist"] = p["stop_atr"] * a
    out["time_stop"] = p["time_stop_bars"]
    valid = ma.notna() & er.notna() & a.notna()
    out.loc[~valid, ["entry_long", "entry_short"]] = False
    return out


STRATEGIES = {"trend": trend_signals, "meanrev": meanrev_signals}


def regime_labels(btc: pd.DataFrame, lookback_bars: int = 180) -> pd.Series:
    """Market regime from BTC's trailing ~30-day (180 x 4H) return, known at bar close.
    bull > +10%, bear < -10%, else range. Used only for REPORTING, never for trading."""
    r = btc.close / btc.close.shift(lookback_bars) - 1
    lab = pd.Series(np.where(r > 0.10, "bull", np.where(r < -0.10, "bear", "range")), index=btc.index)
    lab[r.isna()] = "unknown"
    return lab
