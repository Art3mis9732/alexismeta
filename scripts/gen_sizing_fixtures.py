"""Generate cross-language fixtures: the JS risk sizing (server/risk.js) must reproduce bgbot/sizing.py.

  python scripts/gen_sizing_fixtures.py      -> tests_js/fixtures/sizing_cases.json
"""
from __future__ import annotations

import itertools
import json
import sys
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from bgbot.sizing import size_position  # noqa: E402

INSTR = {  # verified 2026-11-16 from /api/v2/mix/market/contracts (tests_js/fixtures/bitget/contracts.json)
    "BTCUSDT": dict(entry=64900.0, min_qty=0.0001, qty_step=0.0001),
    "ETHUSDT": dict(entry=1821.9, min_qty=0.01, qty_step=0.01),
    "XRPUSDT": dict(entry=0.9607, min_qty=1.0, qty_step=1.0),
}


def main() -> int:
    cases = []
    grid = itertools.product(INSTR.items(), (1000.0, 100.0), (0.001, 0.0025, 0.005), (0.002, 0.01, 0.04),
                             (0.0, 6.0), (1.0, 2.0), (1, -1), (2, 20))
    for (sym, ins), equity, risk_frac, stop_pct, open_risk, max_lev, side, exch_lev in grid:
        inp = dict(equity=equity, entry=ins["entry"], side=side, stop_dist=ins["entry"] * stop_pct, risk_frac=risk_frac,
                   open_risk_usdt=open_risk, max_open_risk_frac=0.01, open_notional=0.0, max_eff_lev=max_lev,
                   taker=0.0006, slip_frac=0.0002, min_qty=ins["min_qty"], qty_step=ins["qty_step"], min_notional=5.0,
                   exchange_lev=exch_lev, mmr=0.004, liq_multiple=2.0)
        r = asdict(size_position(**inp))
        cases.append({"symbol": sym, "input": inp, "output": r})
    out = ROOT / "tests_js" / "fixtures" / "sizing_cases.json"
    out.write_text(json.dumps({"generated_by": "scripts/gen_sizing_fixtures.py from bgbot/sizing.py", "cases": cases}, indent=0))
    ok = sum(1 for c in cases if c["output"]["qty"] > 0)
    print(f"wrote {out}: {len(cases)} cases, {ok} sized, {len(cases) - ok} rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
