"""Fetch PUBLIC Bitget data for the dashboard -> docs/data/market.json. No API key.

  python scripts/fetch_market.py
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bgbot.bitget_public import BitgetPublic  # noqa: E402
from bgbot.config import load_config  # noqa: E402

OUT = ROOT / "docs" / "data" / "market.json"
BARS = 1000          # 15m bars (~10.4 days): enough for the 50-hour EMA and several sessions
M15 = 900_000


def main() -> int:
    cfg = load_config()
    ex = cfg["exchange"]
    api = BitgetPublic(ex["base_url"], ex["product_type"], max_attempts=3)
    now = int(time.time() * 1000)
    out = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
           "generated_at_ms": now,
           "source": "Bitget public REST API v2, USDT-FUTURES (perpetual), 15-minute candles",
           "symbols": {}, "errors": []}
    try:
        tickers, req_ts = api.tickers()
        contracts = {c["symbol"]: c for c in api.contracts()}
        out["server_time_ms"] = req_ts
    except Exception as e:
        out["errors"].append(f"tickers/contracts: {e}")
        tickers, contracts = [], {}
    for sym in ex["symbols"]:
        row: dict = {}
        t = next((x for x in tickers if x.get("symbol") == sym), None)
        c = contracts.get(sym, {})
        if t:
            bid, ask = float(t["bidPr"]), float(t["askPr"])
            row["ticker"] = {
                "ts": int(t["ts"]), "last": float(t["lastPr"]), "mark": float(t.get("markPrice") or "nan"),
                "index": float(t.get("indexPrice") or "nan"), "bid": bid, "ask": ask,
                "spread_bps": round((ask - bid) / ((ask + bid) / 2) * 1e4, 3),
                "funding_rate": float(t.get("fundingRate") or 0),
                "open_interest": float(t.get("holdingAmount") or 0),
                "quote_volume_24h": float(t.get("quoteVolume") or 0), "change_24h": float(t.get("change24h") or 0)}
        row["contract"] = {"status": c.get("symbolStatus"), "min_trade_num": c.get("minTradeNum"),
                           "size_multiplier": c.get("sizeMultiplier"), "min_trade_usdt": c.get("minTradeUSDT"),
                           "fund_interval_h": c.get("fundInterval"), "max_leverage": c.get("maxLever"),
                           "taker_fee": c.get("takerFeeRate"), "maker_fee": c.get("makerFeeRate")}
        try:
            k = api.candles(sym, "15m", now - (BARS + 2) * M15, now)        # closed candles only
            row["candles15m"] = [[int(a), o, h, l, cl, v] for a, o, h, l, cl, v in
                                 zip(k.ts, k.open, k.high, k.low, k.close, k.base_vol)]
        except Exception as e:
            out["errors"].append(f"{sym} candles: {e}")
        try:
            tiers = api.position_tiers(sym)
            row["tier1_mmr"] = float(tiers[0]["keepMarginRate"]) if isinstance(tiers, list) and tiers else None
        except Exception as e:
            out["errors"].append(f"{sym} tiers: {e}")
        for key, path, fields in (
                ("long_short_accounts", "/api/v2/mix/market/account-long-short", ("longAccountRatio", "shortAccountRatio")),
                ("taker_buy_sell", "/api/v2/mix/market/taker-buy-sell", ("buyVolume", "sellVolume"))):
            try:
                data, _ = api._get(path, {"symbol": sym, "period": "15m"})
                row[key] = [[int(d["ts"]), float(d[fields[0]]), float(d[fields[1]])] for d in data]
            except Exception as e:
                out["errors"].append(f"{sym} {key}: {e}")
        out["symbols"][sym] = row
    OUT.parent.mkdir(parents=True, exist_ok=True)
    ok = sum(1 for r in out["symbols"].values() if r.get("candles15m"))
    if ok == 0:
        print("fetch failed, nothing written:", out["errors"])
        return 1
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT}: {ok} symbols with candles; errors={out['errors']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
