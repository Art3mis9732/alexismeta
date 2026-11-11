"""Bar-based portfolio backtester for linear USDT perps.

Modeled (all conservative where a choice was needed):
  * fills: market orders at the NEXT bar open (+ optional extra delay bars), paying
    half-spread + slippage on both sides; every fill is a taker fill (no maker assumption)
  * stops: intrabar stop-market; if the bar OPENS through the stop, fill at the open (gap)
  * stop and exit signal in the same bar: the intrabar stop wins (it happens first)
  * funding: charged at each settlement to positions open at that instant, sign-correct
    (long pays positive rates); entries at the settlement bar open are not charged,
    exits at the settlement bar open ARE charged (conservative)
  * liquidation: isolated margin, tier-1 MMR, checked against MARK-price extremes when
    available (trade-price extremes otherwise). If the mark extreme breaches the
    liquidation price in a bar, the position is liquidated even if the stop is also hit.
  * portfolio limits: open-risk cap, effective-leverage cap, daily-loss entry block,
    drawdown halt (flatten + stop trading)
Not modeled: order-book depth beyond the slippage term, partial fills of market orders,
funding debits shifting the liquidation price, tiered MMR above tier 1, exchange outages.
Missed fills are only approximated by the delayed-execution stress test.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .sizing import size_position
from .strategies import STRATEGIES


@dataclass
class Pos:
    symbol: str
    side: int
    qty: float
    entry_px: float
    entry_time: pd.Timestamp
    stop_px: float
    liq_px: float
    margin: float
    risk_usdt: float
    eff_lev: float
    time_stop: int
    regime: str
    fees: float = 0.0
    funding: float = 0.0
    bars: int = 0


@dataclass
class Result:
    equity: pd.Series
    trades: pd.DataFrame
    notes: list = field(default_factory=list)


def _slip(cfg: dict, sym: str, cost_mult: float) -> float:
    c = cfg["costs"]
    return (c["half_spread_bps"][sym] + c["slippage_bps"]) / 1e4 * cost_mult


def run_backtest(data: dict[str, pd.DataFrame], cfg: dict, strategy: str, *,
                 tier: float = 1.0, exchange_lev: float | None = None, delay: int = 0,
                 cost_mult: float | None = None, start=None, end=None,
                 start_equity: float = 1000.0, regimes: pd.Series | None = None) -> Result:
    risk, costs, margin_cfg, con = cfg["risk"], cfg["costs"], cfg["margin"], cfg["contract"]
    params = cfg["strategy"][strategy]
    cm = costs["cost_multiplier"] if cost_mult is None else cost_mult
    taker = costs["taker_fee"] * cm
    lev = exchange_lev or margin_cfg["exchange_leverage"]
    syms = list(data)
    sig = {s: STRATEGIES[strategy](data[s], params) for s in syms}
    idx = sorted(set().union(*[d.index for d in data.values()]))
    idx = [t for t in idx if (start is None or t >= start) and (end is None or t < end)]
    pos_in = {s: {t: i for i, t in enumerate(data[s].index)} for s in syms}
    notes = []
    if any(data[s]["mark_low"].isna().all() for s in syms):
        notes.append("mark-price candles missing for some symbol: liquidation checked on trade prices")

    cash = start_equity
    positions: dict[str, Pos] = {}
    pending: dict[str, dict] = {}            # symbol -> {"t": exec_time, "action": "enter"/"exit", ...}
    trades, eq_pts = [], []
    peak = start_equity
    day, day_start_eq, block_until = None, start_equity, None
    halted = False
    last_close = {s: np.nan for s in syms}

    def equity_at(prices: dict) -> float:
        return cash + sum(p.side * p.qty * (prices[s] - p.entry_px) for s, p in positions.items())

    def close_pos(s: str, px: float, t, reason: str, fee_rate: float = None) -> None:
        nonlocal cash
        p = positions.pop(s)
        if reason == "liquidation":
            price_pnl, fee = -p.margin, 0.0
        else:
            price_pnl = p.side * p.qty * (px - p.entry_px)
            fee = p.qty * px * (taker if fee_rate is None else fee_rate)
        cash += price_pnl - fee
        p.fees += fee
        net = price_pnl - p.fees + p.funding
        trades.append(dict(symbol=s, side=p.side, entry_time=p.entry_time, exit_time=t, entry_px=p.entry_px,
                           exit_px=px, qty=p.qty, fees=p.fees, funding=p.funding, pnl_net=net,
                           R=net / p.risk_usdt, reason=reason, bars=p.bars, eff_lev=p.eff_lev,
                           regime=p.regime, turnover=p.qty * (p.entry_px + px)))

    for t in idx:
        # ---- day bookkeeping (UTC) ------------------------------------------
        if day != t.date():
            day = t.date()
            day_start_eq = equity_at(last_close)
        # ---- funding settlements at this bar's open -------------------------
        for s, p in positions.items():
            if t in pos_in[s]:
                rate = data[s]["funding"].iat[pos_in[s][t]]
                if rate:
                    px = data[s]["open"].iat[pos_in[s][t]]
                    amt = -p.side * p.qty * px * rate
                    p.funding += amt; cash += amt
        # ---- scheduled actions at the open -----------------------------------
        for s in syms:
            if s not in pending or pending[s]["t"] != t or t not in pos_in[s]:
                continue
            act = pending.pop(s)
            o = data[s]["open"].iat[pos_in[s][t]]
            sl = _slip(cfg, s, cm)
            if act["action"] == "exit" and s in positions:
                p = positions[s]
                close_pos(s, o * (1 - p.side * sl), t, act["reason"])
            elif act["action"] == "enter" and s not in positions and not halted:
                if block_until is not None and t < block_until:
                    continue
                side = act["side"]
                fill = o * (1 + side * sl)
                eq = equity_at({k: (last_close[k] if k in positions else 0) for k in syms})
                r = size_position(
                    equity=eq, entry=fill, side=side, stop_dist=act["stop_dist"],
                    risk_frac=risk["risk_per_trade"] * tier,
                    open_risk_usdt=sum(p.risk_usdt for p in positions.values()),
                    max_open_risk_frac=risk["max_total_open_risk"] * tier,
                    open_notional=sum(p.qty * p.entry_px for p in positions.values()),
                    max_eff_lev=risk["max_effective_leverage"] * tier, taker=taker, slip_frac=sl,
                    min_qty=con["min_qty"][s], qty_step=con["qty_step"][s],
                    min_notional=con["min_notional_usdt"], exchange_lev=lev,
                    mmr=margin_cfg["maint_margin_rate"][s], liq_multiple=risk["liq_distance_multiple_of_stop"])
                if r.qty <= 0:
                    continue
                fee = r.notional * taker
                cash -= fee
                positions[s] = Pos(s, side, r.qty, fill, t, fill - side * act["stop_dist"], r.liq_price, r.margin,
                                   r.risk_usdt, r.effective_leverage, act["time_stop"], act["regime"], fees=fee)
        # ---- intrabar: liquidation, then stops --------------------------------
        for s in list(positions):
            if t not in pos_in[s]:
                continue
            i = pos_in[s][t]
            row = data[s].iloc[i]
            p = positions[s]
            mlo = row.mark_low if not np.isnan(row.mark_low) else row.low
            mhi = row.mark_high if not np.isnan(row.mark_high) else row.high
            sl = _slip(cfg, s, cm)
            if (p.side > 0 and mlo <= p.liq_px) or (p.side < 0 and mhi >= p.liq_px):
                close_pos(s, p.liq_px, t, "liquidation"); continue
            if p.side > 0 and row.low <= p.stop_px:
                px = row.open if row.open <= p.stop_px else p.stop_px
                close_pos(s, px * (1 - sl), t, "stop_gap" if row.open <= p.stop_px else "stop")
            elif p.side < 0 and row.high >= p.stop_px:
                px = row.open if row.open >= p.stop_px else p.stop_px
                close_pos(s, px * (1 + sl), t, "stop_gap" if row.open >= p.stop_px else "stop")
        # ---- close: mark to market, limits, new signals ----------------------
        for s in syms:
            if t in pos_in[s]:
                last_close[s] = data[s]["close"].iat[pos_in[s][t]]
        eq = equity_at(last_close)
        eq_pts.append((t, eq))
        peak = max(peak, eq)
        if not halted and eq <= peak * (1 - risk["max_drawdown_halt"]):
            halted = True
            notes.append(f"drawdown halt at {t}: equity {eq:.2f} vs peak {peak:.2f}")
        if eq <= day_start_eq * (1 - risk["daily_loss_limit"]):
            block_until = (t.normalize() + pd.Timedelta(days=1))
        for s in syms:
            if t not in pos_in[s]:
                continue
            i = pos_in[s][t]
            nxt = i + 1 + delay
            if nxt >= len(data[s].index):
                continue
            exec_t = data[s].index[nxt]
            g = sig[s].iloc[i]
            if s in positions:
                p = positions[s]
                p.bars += 1
                want_exit = (p.side > 0 and g.exit_long) or (p.side < 0 and g.exit_short)
                if s in pending:
                    pass                                  # an exit is already scheduled (delay > 0)
                elif halted:
                    pending[s] = {"t": exec_t, "action": "exit", "reason": "drawdown_halt"}
                elif want_exit:
                    pending[s] = {"t": exec_t, "action": "exit", "reason": "signal"}
                elif p.time_stop and p.bars >= p.time_stop:
                    pending[s] = {"t": exec_t, "action": "exit", "reason": "time_stop"}
            elif s not in pending and not halted:
                side = 1 if g.entry_long else (-1 if g.entry_short else 0)
                if side and g.stop_dist > 0:
                    reg = regimes.get(t, "unknown") if regimes is not None else "n/a"
                    pending[s] = {"t": exec_t, "action": "enter", "side": side, "stop_dist": float(g.stop_dist),
                                  "time_stop": int(g.time_stop), "regime": reg}
    # close anything still open at the last available price (marked as 'end')
    for s in list(positions):
        sl = _slip(cfg, s, cm)
        close_pos(s, last_close[s] * (1 - positions[s].side * sl), idx[-1], "end_of_test")
    if eq_pts:
        eq_pts[-1] = (eq_pts[-1][0], cash)
    equity = pd.Series(dict(eq_pts)).sort_index()
    cols = ["symbol", "side", "entry_time", "exit_time", "entry_px", "exit_px", "qty", "fees", "funding",
            "pnl_net", "R", "reason", "bars", "eff_lev", "regime", "turnover"]
    return Result(equity, pd.DataFrame(trades, columns=cols), notes)


def buy_and_hold(data: dict[str, pd.DataFrame], cfg: dict, *, start=None, end=None,
                 start_equity: float = 1000.0) -> pd.Series:
    """Equal-weight, unlevered long perps (so funding is paid like a perp holder would)."""
    w = start_equity / len(data)
    parts = []
    for s, d in data.items():
        d = d[(d.index >= start) if start is not None else slice(None)]
        d = d[(d.index < end) if end is not None else slice(None)]
        if d.empty:
            continue
        sl = _slip(cfg, s, cfg["costs"]["cost_multiplier"])
        tk = cfg["costs"]["taker_fee"]
        entry = d.open.iloc[0] * (1 + sl)
        qty = w / entry / (1 + tk)
        fund = (-qty * d.open * d.funding).cumsum()
        val = w - qty * entry * tk + qty * (d.close - entry) + fund
        val.iloc[-1] -= qty * d.close.iloc[-1] * (tk + sl)
        parts.append(val)
    return pd.concat(parts, axis=1).ffill().dropna().sum(axis=1)
