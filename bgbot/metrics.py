"""Performance metrics from an equity curve and a trade list."""
from __future__ import annotations

import numpy as np
import pandas as pd


def max_drawdown(equity: pd.Series) -> float:
    peak = equity.cummax()
    return float((1 - equity / peak).max()) if len(equity) else 0.0


def time_underwater_days(equity: pd.Series) -> float:
    peak = equity.cummax()
    under = equity < peak - 1e-9
    longest, cur_start = pd.Timedelta(0), None
    for ts, u in under.items():
        if u and cur_start is None:
            cur_start = ts
        elif not u and cur_start is not None:
            longest = max(longest, ts - cur_start); cur_start = None
    if cur_start is not None:
        longest = max(longest, equity.index[-1] - cur_start)
    return longest / pd.Timedelta(days=1)


def longest_losing_streak(pnls: list[float]) -> int:
    best = cur = 0
    for p in pnls:
        cur = cur + 1 if p < 0 else 0
        best = max(best, cur)
    return best


def summarize(equity: pd.Series, trades: pd.DataFrame, start_equity: float) -> dict:
    daily = equity.resample("1D").last().dropna()
    dret = daily.pct_change().dropna()
    n = len(trades)
    net = float(equity.iloc[-1] - start_equity) if len(equity) else 0.0
    out = {
        "net_pnl_usdt": round(net, 2),
        "net_pnl_pct": round(net / start_equity * 100, 2),
        "max_drawdown_pct": round(max_drawdown(equity) * 100, 2),
        "longest_underwater_days": round(time_underwater_days(equity), 1),
        "worst_day_pct": round(float(dret.min()) * 100, 2) if len(dret) else None,
        "daily_sharpe_ann": round(float(dret.mean() / dret.std() * np.sqrt(365)), 2) if len(dret) > 2 and dret.std() > 0 else None,
        "trades": n,
    }
    if n:
        pnl = trades.pnl_net.values
        wins = pnl[pnl > 0]
        out.update({
            "expectancy_usdt": round(float(pnl.mean()), 4),
            "expectancy_R": round(float(trades.R.mean()), 3),
            "expectancy_R_stderr": round(float(trades.R.std(ddof=1) / np.sqrt(n)), 3) if n > 1 else None,
            "win_rate_pct": round(float((pnl > 0).mean()) * 100, 1),
            "longest_losing_streak": longest_losing_streak(list(pnl)),
            "worst_trade_usdt": round(float(pnl.min()), 2),
            "fees_usdt": round(float(trades.fees.sum()), 2),
            "funding_usdt": round(float(trades.funding.sum()), 2),
            "turnover_x_equity": round(float(trades.turnover.sum()) / start_equity, 1),
            "best5_share_of_net_profit": (round(float(np.sort(pnl)[-5:].sum() / net), 2) if net > 0 else None),
            "liquidations": int((trades.reason == "liquidation").sum()),
            "avg_effective_leverage_at_entry": round(float(trades.eff_lev.mean()), 3),
            "max_effective_leverage_at_entry": round(float(trades.eff_lev.max()), 3),
        })
        _ = wins
    return out


def block_bootstrap_drawdowns(equity: pd.Series, block_days: int, sims: int, seed: int = 7) -> dict:
    """Resample daily returns in contiguous blocks to get a RANGE of plausible drawdowns.
    Limitations: assumes the past return distribution (incl. its regimes) is representative;
    blocks preserve short-range autocorrelation only; cannot create events that never happened."""
    r = equity.resample("1D").last().dropna().pct_change().dropna().values
    if len(r) < block_days * 3:
        return {"note": "too little data for bootstrap"}
    rng = np.random.default_rng(seed)
    n, dds = len(r), []
    for _ in range(sims):
        idx = []
        while len(idx) < n:
            s = rng.integers(0, n - block_days)
            idx.extend(range(s, s + block_days))
        path = np.cumprod(1 + r[idx[:n]])
        dds.append(float((1 - path / np.maximum.accumulate(path)).max()))
    q = np.percentile(dds, [50, 95, 99])
    return {"dd_p50_pct": round(q[0] * 100, 2), "dd_p95_pct": round(q[1] * 100, 2),
            "dd_p99_pct": round(q[2] * 100, 2), "sims": sims, "block_days": block_days}
