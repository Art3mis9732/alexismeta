import numpy as np
import pandas as pd
import pytest

from bgbot.backtest import run_backtest
from bgbot.config import load_config, with_overrides
from bgbot.sizing import isolated_liq_price, round_down, size_position
from bgbot.strategies import trend_signals

BASE = dict(entry=74_000.0, side=1, stop_dist=1_800.0, risk_frac=0.005, open_risk_usdt=0.0,
            max_open_risk_frac=0.015, open_notional=0.0, max_eff_lev=1.0, taker=0.0006, slip_frac=0.00021,
            min_qty=0.001, qty_step=0.001, min_notional=5.0, exchange_lev=5, mmr=0.004, liq_multiple=2.0)


def test_worked_btc_example():
    r = size_position(equity=1000, **BASE)
    assert r.qty == pytest.approx(0.002)
    assert r.risk_usdt == pytest.approx(0.002 * (1800 + 74_000 * 2 * 0.00081))
    assert r.risk_usdt <= 1000 * 0.005
    assert r.margin == pytest.approx(148 / 5)


def test_too_small_account_gets_zero():
    r = size_position(equity=100, **BASE)
    assert r.qty == 0 and "minimum" in r.reason


def test_rounding_is_down():
    assert round_down(0.0029, 0.001) == pytest.approx(0.002)
    assert round_down(0.003, 0.001) == pytest.approx(0.003)


def test_high_leverage_setting_rejected_when_liq_near_stop():
    r = size_position(equity=1000, **{**BASE, "exchange_lev": 50})
    assert r.qty == 0 and "liquidation" in r.reason


def test_liq_formula_long_short_symmetry():
    assert isolated_liq_price(100, 1, 10, 0.0, 0.0) == pytest.approx(90)
    assert isolated_liq_price(100, -1, 10, 0.0, 0.0) == pytest.approx(110)


def test_open_risk_cap_blocks():
    r = size_position(equity=1000, **{**BASE, "open_risk_usdt": 15.0})
    assert r.qty == 0 and "open-risk" in r.reason


# ---- backtest accounting on a hand-made series ---------------------------------
def _bars(prices, funding=None):
    idx = pd.date_range("2025-01-01", periods=len(prices), freq="4h", tz="UTC")
    o = np.array(prices, dtype=float)
    df = pd.DataFrame({"open": o, "high": o * 1.001, "low": o * 0.999, "close": o}, index=idx)
    df["mark_high"], df["mark_low"] = df.high, df.low
    df["funding"] = 0.0 if funding is None else funding
    return df


def _cfg():
    cfg = load_config()
    cfg = with_overrides(cfg, costs={"slippage_bps": 0.0, "half_spread_bps": {"T": 0.0}},
                         contract={"min_qty": {"T": 0.001}, "qty_step": {"T": 0.001}},
                         margin={"maint_margin_rate": {"T": 0.004}, "exchange_leverage": 2},
                         risk={"liq_distance_multiple_of_stop": 0.0})
    cfg["exchange"]["symbols"] = ["T"]
    return cfg


def test_fee_and_funding_accounting_exact():
    # Breakout forces a long entry; then price rises; funding +0.1% charged once while long.
    p = [100.0] * 60 + [103.0, 104.0, 105.0, 106.0, 107.0]
    fund = np.zeros(len(p)); fund[62] = 0.001
    df = _bars(p, fund)
    cfg = _cfg()
    res = run_backtest({"T": df}, cfg, "trend", start_equity=1000)
    t = res.trades
    assert len(t) == 1
    tr = t.iloc[0]
    assert tr.entry_px == pytest.approx(104.0)           # signal at close of bar 60, fill at open of bar 61
    exp_fees = tr.qty * 104.0 * 0.0006 + tr.qty * tr.exit_px * 0.0006
    assert tr.fees == pytest.approx(exp_fees)
    assert tr.funding == pytest.approx(-tr.qty * 105.0 * 0.001)   # long pays positive funding at bar 62 open
    gross = tr.qty * (tr.exit_px - tr.entry_px)
    assert tr.pnl_net == pytest.approx(gross - exp_fees + tr.funding)
    assert res.equity.iloc[-1] == pytest.approx(1000 + tr.pnl_net)


def test_gap_through_stop_fills_at_open_not_stop():
    p = [100.0] * 60 + [103.0, 104.0, 80.0, 80.0]
    df = _bars(p)
    res = run_backtest({"T": df}, _cfg(), "trend", start_equity=1000)
    tr = res.trades.iloc[0]
    assert tr.reason == "stop_gap" and tr.exit_px == pytest.approx(80.0)


def test_no_lookahead_in_signals():
    rng = np.random.default_rng(0)
    p = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 400)))
    df = _bars(p)
    params = load_config()["strategy"]["trend"]
    s1 = trend_signals(df, params)
    df2 = df.copy(); df2.iloc[300:, :4] *= 3          # change the future only
    s2 = trend_signals(df2, params)
    pd.testing.assert_frame_equal(s1.iloc[:300], s2.iloc[:300])


def test_liquidation_when_leverage_setting_too_high():
    p = [100.0] * 60 + [103.0, 104.0, 104.0]
    df = _bars(p)
    df.loc[df.index[62], ["low", "mark_low"]] = 99.0       # ~5% dip: above the 2xATR stop? force liq at 50x
    cfg = with_overrides(_cfg(), margin={"exchange_leverage": 50, "maint_margin_rate": {"T": 0.004}})
    res = run_backtest({"T": df}, cfg, "trend", start_equity=1000)
    assert (res.trades.reason == "liquidation").any()
