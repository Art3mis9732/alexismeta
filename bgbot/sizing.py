"""Position sizing from the amount at risk. Shared by backtest, paper broker and demo.

Run `python -m bgbot.sizing` for the worked BTC example (hypothetical numbers).
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass
class SizeResult:
    qty: float
    reason: str
    notional: float = 0.0
    risk_usdt: float = 0.0          # loss if the stop fills at modeled price, incl. round-trip costs
    margin: float = 0.0             # isolated margin posted = notional / exchange_leverage
    liq_price: float = 0.0
    stop_price: float = 0.0
    entry_fee: float = 0.0
    est_round_trip_cost: float = 0.0
    effective_leverage: float = 0.0


def isolated_liq_price(entry: float, side: int, lev: float, mmr: float, taker: float) -> float:
    """Approximate isolated-margin liquidation price for a linear USDT perp, ignoring
    funding already paid and tiered MMR above tier 1. Derivation (long):
        margin + q(P-E) = (mmr + taker) q P,  margin = qE/lev
        =>  P = E (1 - 1/lev) / (1 - mmr - taker)
    Short: P = E (1 + 1/lev) / (1 + mmr + taker).
    Bitget includes the closing taker fee in maintenance margin (support article 12560603818084).
    Always cross-check with the exchange's own estimated liquidation price in demo."""
    if side > 0:
        return entry * (1 - 1 / lev) / (1 - mmr - taker)
    return entry * (1 + 1 / lev) / (1 + mmr + taker)


def round_down(x: float, step: float) -> float:
    return math.floor(x / step + 1e-9) * step


def size_position(*, equity: float, entry: float, side: int, stop_dist: float,
                  risk_frac: float, open_risk_usdt: float, max_open_risk_frac: float,
                  open_notional: float, max_eff_lev: float,
                  taker: float, slip_frac: float, min_qty: float, qty_step: float,
                  min_notional: float, exchange_lev: float, mmr: float,
                  liq_multiple: float) -> SizeResult:
    """Returns qty 0 with a reason whenever the trade cannot be taken safely."""
    if equity <= 0 or entry <= 0 or not (stop_dist > 0):
        return SizeResult(0.0, "invalid inputs")
    per_unit_cost = entry * 2 * (taker + slip_frac)          # entry + exit fee and slippage per unit
    per_unit_risk = stop_dist + per_unit_cost
    budget = min(equity * risk_frac, equity * max_open_risk_frac - open_risk_usdt)
    if budget <= 0:
        return SizeResult(0.0, "portfolio open-risk limit reached")
    qty = budget / per_unit_risk
    qty = min(qty, max(0.0, equity * max_eff_lev - open_notional) / entry)   # leverage cap
    qty = round_down(qty, qty_step)
    if qty < min_qty:
        return SizeResult(0.0, f"below exchange minimum ({qty:.8g} < {min_qty}): account too small for this stop")
    notional = qty * entry
    if notional < min_notional:
        return SizeResult(0.0, f"notional {notional:.2f} < minimum {min_notional}")
    stop_price = entry - side * stop_dist
    liq = isolated_liq_price(entry, side, exchange_lev, mmr, taker)
    if abs(entry - liq) < liq_multiple * stop_dist:
        return SizeResult(0.0, f"liquidation {liq:.2f} too close: needs >= {liq_multiple}x stop distance; "
                               f"lower the exchange leverage setting", liq_price=liq, stop_price=stop_price)
    return SizeResult(qty=qty, reason="ok", notional=notional, risk_usdt=qty * per_unit_risk,
                      margin=notional / exchange_lev, liq_price=liq, stop_price=stop_price,
                      entry_fee=notional * taker, est_round_trip_cost=qty * per_unit_cost,
                      effective_leverage=notional / equity)


def _demo() -> None:
    print("WORKED BTC EXAMPLE - every input is HYPOTHETICAL / ASSUMED; replace with verified values.\n")
    entry, atr4h = 74_000.0, 900.0          # BTC near 74k on 2026-11-11 (CoinGecko); ATR is an assumption
    stop_dist = 2.0 * atr4h
    common = dict(entry=entry, side=1, stop_dist=stop_dist, risk_frac=0.005, open_risk_usdt=0.0,
                  max_open_risk_frac=0.015, open_notional=0.0, max_eff_lev=1.0, taker=0.0006,
                  slip_frac=0.00021, min_qty=0.001, qty_step=0.001, min_notional=5.0, mmr=0.004,
                  liq_multiple=2.0)
    print(f"entry {entry:,.0f}  ATR(4H) {atr4h:,.0f}  stop = 2 x ATR = {stop_dist:,.0f} "
          f"({stop_dist / entry:.2%})  stop price {entry - stop_dist:,.0f}")
    print(f"round-trip cost per BTC = {entry} x 2 x (0.06% taker + 0.021% slip) = {entry * 2 * 0.00081:,.2f} USDT")
    print(f"risk per BTC = stop {stop_dist:,.0f} + costs = {stop_dist + entry * 2 * 0.00081:,.2f} USDT\n")
    for eq in (100, 500, 1000):
        r = size_position(equity=eq, exchange_lev=5, **common)
        print(f"equity {eq:>5} USDT, risk budget {eq * 0.005:.2f}: qty {r.qty} BTC -> {r.reason}")
        if r.qty:
            print(f"   notional {r.notional:,.2f}  eff.lev {r.effective_leverage:.3f}x  actual risk {r.risk_usdt:.2f} "
                  f"({r.risk_usdt / eq:.2%})  entry fee {r.entry_fee:.3f}  margin@5x {r.margin:.2f}  "
                  f"liq {r.liq_price:,.0f} vs stop {r.stop_price:,.0f}")
    print("\nSame 1,000 USDT trade, exchange leverage SETTING changed (size unchanged):")
    for lev in (2, 5, 10, 20, 50):
        r = size_position(equity=1000, exchange_lev=lev, **common)
        print(f"   {lev:>2}x: margin {r.margin:7.2f}  liq {r.liq_price:>9,.0f}  -> {r.reason}")


if __name__ == "__main__":
    _demo()
