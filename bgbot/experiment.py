"""Pre-registered experiment runner: development period -> lock -> one-shot holdout.

  python -m bgbot.experiment dev       # development window only (first 75%), logs the variant
  python -m bgbot.experiment lock      # freezes the current config hash
  python -m bgbot.experiment holdout   # runs ONCE on the final 25% with the frozen config

Outputs land in results/. Nothing here places orders.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .backtest import buy_and_hold, run_backtest
from .config import ROOT, load_config, variant_hash, with_overrides
from .data import RAW, load_universe
from .metrics import block_bootstrap_drawdowns, summarize
from .strategies import STRATEGIES, regime_labels

RESULTS = ROOT / "results"
START_EQ = 1000.0            # hypothetical; results scale ~linearly until min-size rounding bites


def split(data: dict) -> tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]:
    start = max(d.index[0] for d in data.values())
    end = min(d.index[-1] for d in data.values())
    return start, end


def windows(data: dict, cfg: dict):
    start, end = split(data)
    cut = start + (end - start) * (1 - cfg["validation"]["holdout_fraction"])
    return start, cut.floor("D"), end + pd.Timedelta(hours=4)


def joint_gap_scenario(data: dict, cfg: dict, strategy: str, tier: float) -> dict:
    """All three coins gap against full-size positions at the same moment by their worst
    historical single-bar move, filling beyond the stops. Measures what the open-risk cap
    is really worth when correlation goes to 1."""
    r = cfg["risk"]
    p = cfg["strategy"][strategy]
    per_coin_risk = r["max_total_open_risk"] * tier / len(data)
    loss = 0.0
    detail = {}
    for s, d in data.items():
        prev = d.close.shift(1)
        worst = float(max((prev - d.low).div(prev).max(), (d.high - prev).div(prev).max()))
        stop_frac = float((STRATEGIES[strategy](d, p).stop_dist / d.close).median())
        notional_frac = min(per_coin_risk / stop_frac, r["max_effective_leverage"] * tier / len(data))
        coin_loss = notional_frac * max(worst, stop_frac)
        detail[s] = {"worst_bar_move_pct": round(worst * 100, 2), "median_stop_pct": round(stop_frac * 100, 2),
                     "loss_pct_equity": round(coin_loss * 100, 2)}
        loss += coin_loss
    return {"total_loss_pct_equity": round(loss * 100, 2), "per_coin": detail,
            "vs_daily_limit_pct": r["daily_loss_limit"] * 100, "vs_dd_halt_pct": r["max_drawdown_halt"] * 100}


def group_table(trades: pd.DataFrame, key: str) -> list[dict]:
    if trades.empty:
        return []
    g = trades.groupby(key)
    return [{key: k, "trades": len(v), "net_usdt": round(v.pnl_net.sum(), 2),
             "expectancy_R": round(v.R.mean(), 3)} for k, v in g]


def fold_results(data, cfg, strategy, start, cut, k):
    edges = pd.date_range(start, cut, periods=k + 1)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        res = run_backtest(data, cfg, strategy, start=a, end=b, start_equity=START_EQ)
        m = summarize(res.equity, res.trades, START_EQ) if len(res.equity) else {}
        out.append({"from": str(a.date()), "to": str(b.date()), "net_pct": m.get("net_pnl_pct"),
                    "trades": m.get("trades"), "maxdd_pct": m.get("max_drawdown_pct")})
    return out


def evaluate(data: dict, cfg: dict, a, b, label: str) -> dict:
    btc = data.get("BTCUSDT", next(iter(data.values())))
    regimes = regime_labels(btc)
    rep = {"window": label, "from": str(a), "to": str(b), "start_equity_usdt": START_EQ,
           "variant": variant_hash(cfg), "strategies": {}}
    bh = buy_and_hold(data, cfg, start=a, end=b, start_equity=START_EQ)
    rep["cash"] = {"net_pnl_pct": 0.0, "max_drawdown_pct": 0.0, "note": "USDT idle; ignores exchange counterparty risk"}
    rep["buy_and_hold_unlevered"] = summarize(bh, pd.DataFrame(columns=["pnl_net"]), START_EQ)
    for strat in STRATEGIES:
        S = {}
        for tier in (1, 2, 3):
            res = run_backtest(data, cfg, strat, tier=tier, start=a, end=b, start_equity=START_EQ, regimes=regimes)
            m = summarize(res.equity, res.trades, START_EQ)
            S[f"exposure_tier_{tier}x"] = {"metrics": m, "notes": res.notes}
            # same tier with the drawdown halt switched off, to see raw exposure scaling
            nh = with_overrides(cfg, risk={"max_drawdown_halt": 1.0})
            rn = run_backtest(data, nh, strat, tier=tier, start=a, end=b, start_equity=START_EQ, regimes=regimes)
            mn = summarize(rn.equity, rn.trades, START_EQ)
            S[f"exposure_tier_{tier}x_no_halt"] = {k: mn.get(k) for k in
                                                   ("net_pnl_pct", "max_drawdown_pct", "trades", "expectancy_R", "worst_day_pct")}
            if tier == 1:
                base = res
                S["by_coin"] = group_table(res.trades, "symbol")
                S["by_regime"] = group_table(res.trades, "regime")
                S["bootstrap"] = block_bootstrap_drawdowns(res.equity, cfg["validation"]["bootstrap_block_days"],
                                                           cfg["validation"]["bootstrap_sims"])
                res.trades.to_csv(RESULTS / f"trades_{label}_{strat}.csv", index=False)
                res.equity.to_csv(RESULTS / f"equity_{label}_{strat}.csv")
        # Exchange leverage SETTING with identical position size: the liquidation-buffer
        # sizing rule is switched off here so that ONLY the setting changes.
        S["leverage_setting_same_size"] = {}
        no_buf = with_overrides(cfg, risk={"liq_distance_multiple_of_stop": 0.0})
        for lev in (2, 5, 10, 20, 50):
            r2 = run_backtest(data, no_buf, strat, tier=1, exchange_lev=lev, start=a, end=b, start_equity=START_EQ)
            m2 = summarize(r2.equity, r2.trades, START_EQ)
            S["leverage_setting_same_size"][f"{lev}x"] = {k: m2.get(k) for k in
                                                          ("net_pnl_pct", "max_drawdown_pct", "trades", "liquidations")}
        stress = {}
        for name, kw in {"costs_x2": {"cost_mult": 2.0}, "delay_1_bar": {"delay": 1},
                         "costs_x2_and_delay": {"cost_mult": 2.0, "delay": 1}}.items():
            r3 = run_backtest(data, cfg, strat, tier=1, start=a, end=b, start_equity=START_EQ, **kw)
            m3 = summarize(r3.equity, r3.trades, START_EQ)
            stress[name] = {k: m3.get(k) for k in ("net_pnl_pct", "max_drawdown_pct", "expectancy_R", "trades")}
        S["stress"] = stress
        S["joint_gap_against_all_three"] = joint_gap_scenario(data, cfg, strat, 1)
        _ = base
        rep["strategies"][strat] = S
    return rep


def check_criteria(rep: dict, cfg: dict, folds: dict | None) -> dict:
    c = cfg["criteria"]
    verdicts = {}
    bh = rep["buy_and_hold_unlevered"]
    bh_mar = (bh["net_pnl_pct"] / bh["max_drawdown_pct"]) if bh.get("max_drawdown_pct") else None
    for strat, S in rep["strategies"].items():
        m = S["exposure_tier_1x"]["metrics"]
        by_coin = {r["symbol"]: r["trades"] for r in S["by_coin"]}
        mar = (m["net_pnl_pct"] / m["max_drawdown_pct"]) if m.get("max_drawdown_pct") else None
        chk = {
            "enough_trades_total": m["trades"] >= c["min_trades_total"],
            "enough_trades_each_coin": all(by_coin.get(s, 0) >= c["min_trades_per_coin"] for s in cfg["exchange"]["symbols"]),
            "expectancy_R_base": (m.get("expectancy_R") or -9) >= c["min_expectancy_R"],
            "positive_with_costs_x2_and_delay": (S["stress"]["costs_x2_and_delay"].get("expectancy_R") or -9) > 0,
            "beats_cash": m["net_pnl_pct"] > 0,
            "return_per_drawdown_beats_buy_hold": (mar is not None and (bh_mar is None or mar >= bh_mar)),
            "max_drawdown": m["max_drawdown_pct"] <= c["max_drawdown"] * 100,
            "bootstrap_dd_p95": (S["bootstrap"].get("dd_p95_pct", 999) <= c["max_bootstrap_dd_p95"] * 100),
            "not_dominated_by_best5": (m.get("best5_share_of_net_profit") is not None and
                                       m["best5_share_of_net_profit"] <= c["max_best5_profit_share"]),
            "no_liquidations": m.get("liquidations", 0) == 0,
        }
        if folds is not None:
            f = folds[strat]
            pos = [x for x in f if (x["net_pct"] or 0) > 0]
            chk["positive_fold_share"] = len(pos) / max(1, len(f)) >= c["min_positive_fold_share"]
        chk = {k: bool(v) for k, v in chk.items()}
        verdicts[strat] = {"checks": chk, "all_pass": all(chk.values())}
    return verdicts


def decision(verdicts: dict, phase: str) -> str:
    if any(v["all_pass"] for v in verdicts.values()):
        return "CONTINUE TESTING (paper/demo next; still no real money)" if phase == "holdout" else \
               "CONTINUE TESTING (dev looks acceptable; lock and run the holdout once)"
    return "REJECT (cash beats the bot on the stated objectives)" if phase == "holdout" else \
           "REVISE or REJECT (fails on development data; any revision is a new counted variant)"


def _j(o) -> str:
    return json.dumps(o, default=lambda x: x.item() if hasattr(x, "item") else str(x))


def write_md(rep: dict, verdicts: dict, folds, dec: str, fn: Path, n_variants: int) -> None:
    L = [f"# {rep['window'].upper()} report", "",
         f"Window: {rep['from']} -> {rep['to']}  |  variant {rep['variant']}  |  variants tried so far: {n_variants}",
         f"Hypothetical start equity {START_EQ} USDT. SIMULATION RESULTS - not live performance.", "",
         f"**Decision: {dec}**", "",
         "## Baselines", f"- Cash: 0.00%",
         f"- Buy & hold (equal-weight, unlevered perps): {_j(rep['buy_and_hold_unlevered'])}", ""]
    for strat, S in rep["strategies"].items():
        L += [f"## {strat}", "", "| tier | net % | maxDD % | trades | exp R | worst day % | liqs |", "|---|---|---|---|---|---|---|"]
        for k in ("exposure_tier_1x", "exposure_tier_2x", "exposure_tier_3x"):
            m = S[k]["metrics"]
            L.append(f"| {k} | {m.get('net_pnl_pct')} | {m.get('max_drawdown_pct')} | {m.get('trades')} | "
                     f"{m.get('expectancy_R')} | {m.get('worst_day_pct')} | {m.get('liquidations')} |")
            nh = S[k + "_no_halt"]
            L.append(f"| {k} (halt off) | {nh.get('net_pnl_pct')} | {nh.get('max_drawdown_pct')} | {nh.get('trades')} | "
                     f"{nh.get('expectancy_R')} | {nh.get('worst_day_pct')} | - |")
        L += ["", "Full tier-1 metrics: `" + _j(S["exposure_tier_1x"]["metrics"]) + "`", "",
              "Exchange leverage SETTING, same position size: `" + _j(S["leverage_setting_same_size"]) + "`", "",
              "Stress: `" + _j(S["stress"]) + "`", "",
              "Joint gap scenario: `" + _j(S["joint_gap_against_all_three"]) + "`", "",
              "Bootstrap drawdown range: `" + _j(S["bootstrap"]) + "`", "",
              "By coin: `" + _j(S["by_coin"]) + "`", "", "By regime: `" + _j(S["by_regime"]) + "`", ""]
        if folds:
            L += ["Folds: `" + _j(folds[strat]) + "`", ""]
        L += ["Criteria: `" + _j(verdicts[strat]) + "`", ""]
        if S["exposure_tier_1x"]["notes"]:
            L += ["Notes: " + "; ".join(S["exposure_tier_1x"]["notes"]), ""]
    fn.write_text("\n".join(L))


def log_variant(cfg: dict, phase: str) -> int:
    fn = RESULTS / "variants.jsonl"
    with open(fn, "a") as f:
        f.write(json.dumps({"variant": variant_hash(cfg), "phase": phase, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n")
    return len({json.loads(x)["variant"] for x in fn.read_text().splitlines() if x.strip()})


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["dev", "lock", "holdout"])
    ap.add_argument("--config", default=None)
    ap.add_argument("--raw-dir", default=None, help="override data/raw (used by the synthetic smoke test)")
    ap.add_argument("--tag", default="", help="suffix for output files")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    RESULTS.mkdir(exist_ok=True)
    lock = RESULTS / f"holdout{a.tag}.lock"
    if a.phase == "lock":
        lock.write_text(json.dumps({"variant": variant_hash(cfg), "locked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
        print(f"locked variant {variant_hash(cfg)} -> {lock}"); return
    data = load_universe(cfg["exchange"]["symbols"], cfg["exchange"]["signal_bar"],
                         raw_dir=Path(a.raw_dir) if a.raw_dir else RAW)
    start, cut, end = windows(data, cfg)
    if a.phase == "dev":
        n = log_variant(cfg, "dev")
        rep = evaluate(data, cfg, start, cut, "dev" + a.tag)
        folds = {s: fold_results(data, cfg, s, start, cut, cfg["validation"]["dev_folds"]) for s in STRATEGIES}
        v = check_criteria(rep, cfg, folds)
        dec = decision(v, "dev")
    else:
        if not lock.exists():
            raise SystemExit("No lock file. Run `experiment lock` first; never open the holdout before freezing.")
        locked = json.loads(lock.read_text())["variant"]
        if locked != variant_hash(cfg):
            raise SystemExit(f"Config changed since lock ({locked} != {variant_hash(cfg)}). The holdout is only valid for the locked variant.")
        out = RESULTS / f"holdout{a.tag}_report.md"
        if out.exists():
            raise SystemExit(f"{out} already exists: the holdout was used. Re-running it is no longer an out-of-sample test.")
        n = log_variant(cfg, "holdout")
        rep = evaluate(data, cfg, cut, end, "holdout" + a.tag)
        folds = None
        v = check_criteria(rep, cfg, None)
        dec = decision(v, "holdout")
    (RESULTS / f"{a.phase}{a.tag}_report.json").write_text(json.dumps({"report": rep, "verdicts": v, "folds": folds, "decision": dec}, indent=2, default=lambda x: x.item() if hasattr(x, "item") else str(x)))
    write_md(rep, v, folds, dec, RESULTS / f"{a.phase}{a.tag}_report.md", n)
    print((RESULTS / f"{a.phase}{a.tag}_report.md").read_text()[:6000])


if __name__ == "__main__":
    main()
