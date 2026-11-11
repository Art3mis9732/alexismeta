"""Public, key-free Bitget market data: snapshot + historical downloader.

Endpoint paths were checked against Bitget's API docs / endpoint index on 2026-11-11
(classic "mix" v2 market-data endpoints; the newer UTA v3 market endpoints also exist):
  GET /api/v2/mix/market/contracts              contract specs (min size, steps, status)
  GET /api/v2/mix/market/tickers                last/mark/index/bid/ask/funding/OI
  GET /api/v2/mix/market/history-candles        trade-price candles, <=200 per call
  GET /api/v2/mix/market/history-mark-candles   mark-price candles (liquidation uses mark)
  GET /api/v2/mix/market/history-fund-rate      settled funding history (paged)
  GET /api/v2/mix/market/query-position-lever   position tiers incl. maintenance margin rate

Individual parameter names/response fields were NOT all verified line by line, so this
client fails loudly (prints the raw response) on anything unexpected rather than guessing.

Usage (PowerShell, from the project folder):
  python -m bgbot.bitget_public snapshot
  python -m bgbot.bitget_public download --days 1095
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

from .config import ROOT, load_config

IST = timezone(timedelta(hours=5, minutes=30))
GRAN_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
           "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000}
DATA_DIR = ROOT / "data"


class BitgetAPIError(RuntimeError):
    pass


class BitgetPublic:
    def __init__(self, base_url: str, product_type: str, min_interval_s: float = 0.12,
                 timeout_s: float = 10.0, max_attempts: int = 6):
        self.base = base_url.rstrip("/")
        self.product_type = product_type
        self.min_interval = min_interval_s     # ~8 req/s, well under the documented 20/s/IP
        self.timeout = timeout_s
        self.max_attempts = max_attempts
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "bitget-edge-lab/0.1 (research, public data)"
        self._last = 0.0

    def _get(self, path: str, params: dict) -> tuple[object, int | None]:
        delay = 1.0
        for attempt in range(self.max_attempts):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                r = self.s.get(self.base + path, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                print(f"  network error on {path} ({e}); retry in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay); delay *= 2
                continue
            if r.status_code == 429 or r.status_code >= 500:
                print(f"  HTTP {r.status_code} on {path}; retry in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay); delay *= 2
                continue
            try:
                j = r.json()
            except ValueError:
                raise BitgetAPIError(f"{path}: non-JSON response HTTP {r.status_code}: {r.text[:300]}")
            if str(j.get("code")) != "00000":
                raise BitgetAPIError(f"{path} {params} -> code={j.get('code')} msg={j.get('msg')}")
            return j.get("data"), j.get("requestTime")
        raise BitgetAPIError(f"{path}: retries exhausted")

    # ---- reference data -------------------------------------------------
    def contracts(self) -> list[dict]:
        data, _ = self._get("/api/v2/mix/market/contracts", {"productType": self.product_type})
        return data

    def tickers(self) -> tuple[list[dict], int | None]:
        return self._get("/api/v2/mix/market/tickers", {"productType": self.product_type})

    def position_tiers(self, symbol: str) -> list[dict]:
        data, _ = self._get("/api/v2/mix/market/query-position-lever",
                            {"symbol": symbol, "productType": self.product_type})
        return data

    # ---- history --------------------------------------------------------
    def candles(self, symbol: str, granularity: str, start_ms: int, end_ms: int,
                kind: str = "trade") -> pd.DataFrame:
        """Page backwards from end_ms in windows of 200 candles."""
        path = {"trade": "/api/v2/mix/market/history-candles",
                "mark": "/api/v2/mix/market/history-mark-candles"}[kind]
        step = GRAN_MS[granularity]
        rows: list[list] = []
        end = end_ms - (end_ms % step)
        empty_streak = 0
        while end > start_ms:
            win_start = max(start_ms, end - 200 * step)
            data, _ = self._get(path, {"symbol": symbol, "productType": self.product_type,
                                       "granularity": granularity, "startTime": str(win_start),
                                       "endTime": str(end), "limit": "200"})
            if not isinstance(data, list):
                raise BitgetAPIError(f"unexpected candle payload: {str(data)[:300]}")
            if data:
                rows.extend(data)
                empty_streak = 0
            else:
                empty_streak += 1
                if empty_streak >= 5:      # five empty windows in a row: assume history starts here
                    print(f"  {symbol} {kind}: no data before {_fmt(win_start)}; stopping", file=sys.stderr)
                    break
            end = win_start
        if not rows:
            return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "base_vol", "quote_vol"])
        width = len(rows[0])
        cols = ["ts", "open", "high", "low", "close", "base_vol", "quote_vol"][:width]
        df = pd.DataFrame([r[:len(cols)] for r in rows], columns=cols)
        df = df.astype(float)
        df["ts"] = df["ts"].astype("int64")
        df = df.drop_duplicates("ts").sort_values("ts")
        return df[(df.ts >= start_ms) & (df.ts < end_ms)].reset_index(drop=True)

    def funding_history(self, symbol: str, start_ms: int, max_pages: int = 400) -> pd.DataFrame:
        out = []
        for page in range(1, max_pages + 1):
            data, _ = self._get("/api/v2/mix/market/history-fund-rate",
                                {"symbol": symbol, "productType": self.product_type,
                                 "pageSize": "100", "pageNo": str(page)})
            if not data:
                break
            out.extend(data)
            oldest = min(int(d["fundingTime"]) for d in data)
            if oldest < start_ms:
                break
        if not out:
            return pd.DataFrame(columns=["ts", "rate"])
        df = pd.DataFrame({"ts": [int(d["fundingTime"]) for d in out],
                           "rate": [float(d["fundingRate"]) for d in out]})
        df = df.drop_duplicates("ts").sort_values("ts")
        return df[df.ts >= start_ms].reset_index(drop=True)


def _fmt(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _both_tz(ms: int) -> str:
    t = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return f"{t:%Y-%m-%d %H:%M:%S} UTC / {t.astimezone(IST):%Y-%m-%d %H:%M:%S} IST"


def gap_report(df: pd.DataFrame, step_ms: int) -> dict:
    if df.empty:
        return {"rows": 0, "missing_bars": None, "gaps": []}
    d = df.ts.diff().dropna()
    gaps = df.ts[1:][d.values != step_ms]
    gap_list = [{"after": _fmt(int(df.ts.iloc[i - 1])), "bars_missing": int(d.iloc[i - 1] / step_ms) - 1}
                for i in gaps.index]
    return {"rows": len(df), "first": _fmt(int(df.ts.iloc[0])), "last": _fmt(int(df.ts.iloc[-1])),
            "missing_bars": int(sum(g["bars_missing"] for g in gap_list)), "gaps": gap_list[:50]}


# ---- CLI commands -----------------------------------------------------------
def cmd_snapshot(cfg: dict) -> None:
    ex = cfg["exchange"]
    api = BitgetPublic(ex["base_url"], ex["product_type"])
    tick, req_ts = api.tickers()
    contracts = {c["symbol"]: c for c in api.contracts()}
    snap_dir = DATA_DIR / "snapshots"; snap_dir.mkdir(parents=True, exist_ok=True)
    raw = {"requestTime": req_ts, "tickers": [], "contracts": {}, "tiers": {}}
    print(f"Bitget public snapshot, server requestTime {_both_tz(int(req_ts))}" if req_ts else "Bitget snapshot")
    print("Units: prices in USDT; funding = rate per settlement interval; OI (holdingAmount) in base coin.\n")
    for sym in ex["symbols"]:
        t = next((x for x in tick if x.get("symbol") == sym), None)
        c = contracts.get(sym)
        if t is None or c is None:
            print(f"{sym}: NOT FOUND in tickers/contracts -> verify the symbol before doing anything else")
            continue
        raw["tickers"].append(t); raw["contracts"][sym] = c
        bid, ask = float(t["bidPr"]), float(t["askPr"])
        spread_bps = (ask - bid) / ((ask + bid) / 2) * 1e4
        print(f"== {sym}  status={c.get('symbolStatus')}  ticker ts={_both_tz(int(t['ts']))}")
        print(f"   last={t.get('lastPr')} mark={t.get('markPrice')} index={t.get('indexPrice')} "
              f"bid={bid} ask={ask} spread={spread_bps:.2f} bps")
        print(f"   funding(current interval)={t.get('fundingRate')}  OI={t.get('holdingAmount')} {c.get('baseCoin')}"
              f"  24h quote vol={t.get('quoteVolume')}")
        print(f"   minTradeNum={c.get('minTradeNum')} sizeMultiplier={c.get('sizeMultiplier')} "
              f"volumePlace={c.get('volumePlace')} pricePlace={c.get('pricePlace')} minTradeUSDT={c.get('minTradeUSDT')}")
        print(f"   fee maker/taker (contract default)={c.get('makerFeeRate')}/{c.get('takerFeeRate')} "
              f"fundInterval(h)={c.get('fundInterval')} maxLever={c.get('maxLever')}")
        try:
            tiers = api.position_tiers(sym)
            raw["tiers"][sym] = tiers
            first = tiers[0] if isinstance(tiers, list) and tiers else tiers
            print(f"   tier-1 position tier: {json.dumps(first)}")
        except BitgetAPIError as e:
            print(f"   tier query failed: {e}")
        print()
    fn = snap_dir / f"snapshot_{int(time.time())}.json"
    fn.write_text(json.dumps(raw, indent=2))
    print(f"raw snapshot saved to {fn}")
    print("Copy minTradeNum/sizeMultiplier/minTradeUSDT and tier-1 keepMarginRate into config/default.toml.")


def cmd_download(cfg: dict, days: int) -> None:
    ex = cfg["exchange"]
    api = BitgetPublic(ex["base_url"], ex["product_type"])
    gran = ex["download_granularity"]
    end_ms = int(time.time() * 1000)
    end_ms -= end_ms % GRAN_MS[gran]           # only closed candles
    start_ms = end_ms - days * 86_400_000
    raw_dir = DATA_DIR / "raw"; raw_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"source": "Bitget public REST (actual Bitget USDT-M perpetual data, not a proxy)",
                "downloaded_at": _both_tz(int(time.time() * 1000)),
                "requested_range": [_fmt(start_ms), _fmt(end_ms)], "granularity": gran, "series": {}}
    for sym in ex["symbols"]:
        for kind in ("trade", "mark"):
            print(f"downloading {sym} {kind} {gran} candles ...")
            df = api.candles(sym, gran, start_ms, end_ms, kind)
            fn = raw_dir / f"{sym}_{gran}_{kind}.csv"
            df.to_csv(fn, index=False)
            manifest["series"][f"{sym}_{kind}"] = {"file": fn.name, **gap_report(df, GRAN_MS[gran])}
        print(f"downloading {sym} funding history ...")
        f = api.funding_history(sym, start_ms)
        fn = raw_dir / f"{sym}_funding.csv"
        f.to_csv(fn, index=False)
        manifest["series"][f"{sym}_funding"] = {
            "file": fn.name, "rows": len(f),
            "first": _fmt(int(f.ts.iloc[0])) if len(f) else None,
            "last": _fmt(int(f.ts.iloc[-1])) if len(f) else None,
            "observed_intervals_h": sorted(set((f.ts.diff().dropna() / 3_600_000).round(2).tolist()))[:10]}
    (DATA_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2)[:4000])
    print(f"\nmanifest written to {DATA_DIR / 'manifest.json'}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["snapshot", "download"])
    ap.add_argument("--days", type=int, default=1095)
    ap.add_argument("--config", default=None)
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    if a.command == "snapshot":
        cmd_snapshot(cfg)
    else:
        cmd_download(cfg, a.days)


if __name__ == "__main__":
    main()
