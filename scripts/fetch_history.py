"""Download 15-minute Bitget perp history for the pattern test -> data/hist/<SYM>_15m.json

  python scripts/fetch_history.py --days 180
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bgbot.bitget_public import BitgetPublic, gap_report  # noqa: E402
from bgbot.config import load_config  # noqa: E402

STEP = {"5m": 300_000, "15m": 900_000, "4H": 14_400_000}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--gran", default="15m", choices=["5m", "15m", "4H"])
    a = ap.parse_args()
    cfg = load_config()
    ex = cfg["exchange"]
    api = BitgetPublic(ex["base_url"], ex["product_type"])
    now = int(time.time() * 1000)
    out_dir = ROOT / "data" / "hist"
    out_dir.mkdir(parents=True, exist_ok=True)
    for sym in ex["symbols"]:
        k = api.candles(sym, a.gran, now - a.days * 86_400_000, now - now % STEP[a.gran])
        rows = [[int(t), o, h, l, c, v] for t, o, h, l, c, v in zip(k.ts, k.open, k.high, k.low, k.close, k.base_vol)]
        (out_dir / f"{sym}_{a.gran}.json").write_text(json.dumps(rows, separators=(",", ":")))
        g = gap_report(k, STEP[a.gran])
        print(sym, a.gran, {x: g.get(x) for x in ("rows", "first", "last", "missing_bars")})
    return 0


if __name__ == "__main__":
    sys.exit(main())
