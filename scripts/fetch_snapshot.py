"""Fetch PUBLIC Bitget market data and write docs/data/latest.json for the dashboard.

Runs hourly in GitHub Actions (see .github/workflows/snapshot.yml) or locally:
  python scripts/fetch_snapshot.py
No API key is used or accepted.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bgbot.bitget_public import BitgetPublic, BitgetAPIError  # noqa: E402
from bgbot.config import load_config  # noqa: E402

OUT = ROOT / "docs" / "data" / "latest.json"


def main() -> int:
    cfg = load_config()
    ex = cfg["exchange"]
    api = BitgetPublic(ex["base_url"], ex["product_type"], max_attempts=3)
    now_ms = int(time.time() * 1000)
    out = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
           "source": "Bitget public REST API v2 (USDT-FUTURES), fetched by GitHub Actions",
           "units": {"prices": "USDT", "funding": "rate per settlement interval",
                     "open_interest": "base coin", "spread": "basis points"},
           "symbols": {}, "errors": []}
    try:
        tickers, req_ts = api.tickers()
        contracts = {c["symbol"]: c for c in api.contracts()}
        out["server_time_ms"] = req_ts
    except Exception as e:                               # e.g. runner IP blocked / outage
        out["errors"].append(f"tickers/contracts: {e}")
        tickers, contracts = [], {}
    for sym in ex["symbols"]:
        t = next((x for x in tickers if x.get("symbol") == sym), None)
        c = contracts.get(sym, {})
        if t is None:
            out["errors"].append(f"{sym}: not in ticker response")
            continue
        bid, ask = float(t["bidPr"]), float(t["askPr"])
        row = {
            "ticker_ts_ms": int(t["ts"]), "last": float(t["lastPr"]),
            "mark": float(t.get("markPrice") or "nan"), "index": float(t.get("indexPrice") or "nan"),
            "bid": bid, "ask": ask, "spread_bps": round((ask - bid) / ((ask + bid) / 2) * 1e4, 3),
            "funding_rate": float(t.get("fundingRate") or 0), "open_interest": float(t.get("holdingAmount") or 0),
            "quote_volume_24h": float(t.get("quoteVolume") or 0), "change_24h": float(t.get("change24h") or 0),
            "status": c.get("symbolStatus"), "min_trade_num": c.get("minTradeNum"),
            "size_multiplier": c.get("sizeMultiplier"), "min_trade_usdt": c.get("minTradeUSDT"),
            "fund_interval_h": c.get("fundInterval"), "max_leverage": c.get("maxLever"),
            "taker_fee_default": c.get("takerFeeRate"), "maker_fee_default": c.get("makerFeeRate"),
        }
        try:
            f = api.funding_history(sym, now_ms - 30 * 86_400_000, max_pages=2)
            row["funding_history"] = [[int(a), float(b)] for a, b in zip(f.ts, f.rate)]
        except Exception as e:
            out["errors"].append(f"{sym} funding history: {e}")
        try:
            k = api.candles(sym, "4H", now_ms - 30 * 86_400_000, now_ms - now_ms % 14_400_000)
            row["closes_4h"] = [[int(a), float(b)] for a, b in zip(k.ts, k.close)]
        except Exception as e:
            out["errors"].append(f"{sym} candles: {e}")
        try:
            tiers = api.position_tiers(sym)
            row["tier1"] = tiers[0] if isinstance(tiers, list) and tiers else None
        except Exception as e:
            out["errors"].append(f"{sym} tiers: {e}")
        out["symbols"][sym] = row
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if not out["symbols"] and OUT.exists():
        # keep the last good data, but record the failure so the page can show it
        prev = json.loads(OUT.read_text())
        prev["last_attempt_utc"] = out["generated_at_utc"]
        prev["last_attempt_errors"] = out["errors"]
        OUT.write_text(json.dumps(prev, indent=1))
        print("fetch failed; kept previous data:", out["errors"])
        return 0
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {OUT} with {len(out['symbols'])} symbols; errors={out['errors']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
