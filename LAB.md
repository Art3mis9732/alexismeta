# bitget-edge-lab — milestone 1 (public data + backtest; no keys, no orders)

The goal is to find out cheaply whether a simple BTC/ETH/XRP perpetual strategy has an edge
that survives fees, funding, slippage and leverage. **Until the holdout passes, nothing here
should trade real money.** Live trading is disabled in code (`bgbot/oms.py: live_allowed`).

## Folder layout
```
bitget-edge-lab/
  config/default.toml      every assumption in one place (marked ASSUMPTION)
  bgbot/bitget_public.py   public snapshot + historical downloader (no API key)
  bgbot/data.py            1H -> 4H bars, mark-price extremes, funding at settlement times
  bgbot/strategies.py      the two pre-registered strategies (rules written before testing)
  bgbot/sizing.py          risk-based sizing, rounding, min-size, liquidation buffer (shared by all modes)
  bgbot/backtest.py        portfolio backtester (fees, spread, slippage, funding, gaps, liquidation, limits)
  bgbot/metrics.py         P&L, drawdown, underwater time, streaks, best-5 share, block bootstrap
  bgbot/experiment.py      dev -> lock -> one-shot holdout, stress tests, pass/fail criteria
  bgbot/oms.py             order-safety layer + fake exchange (basis for paper broker / demo adapter)
  bgbot/synthetic.py       fake data for plumbing tests only
  tests/                   22 tests: sizing, fee/funding accounting, gaps, look-ahead, liquidation, OMS
```

## Setup (Windows 11, PowerShell, Python 3.11+)
```powershell
cd $HOME\Downloads\bitget-edge-lab          # wherever you unzipped it
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1                 # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install -r requirements.txt
python -m pytest -q                          # expect: 22 passed
python -m bgbot.sizing                       # worked BTC sizing example
```

## Step 1 — verify instruments and get a timestamped market snapshot
```powershell
python -m bgbot.bitget_public snapshot
```
Expected: for each of BTCUSDT / ETHUSDT / XRPUSDT a block showing `status=normal` (or whatever
Bitget returns), last/mark/index price, bid/ask spread in bps, current funding rate, OI, minTradeNum,
sizeMultiplier, minTradeUSDT, fundInterval and the tier-1 position tier. A raw JSON copy goes to
`data/snapshots/`. **Copy the min size, step, minTradeUSDT and tier-1 keepMarginRate into
`config/default.toml`** before step 3. If a symbol prints NOT FOUND, stop and tell me.

## Step 2 — download history (free, ~10–20 min)
```powershell
python -m bgbot.bitget_public download --days 1095
```
Writes `data/raw/*.csv` (1H trade candles, 1H mark candles, funding history) and `data/manifest.json`
with the actual date range, row counts, gaps and observed funding intervals. If Bitget returns less
history than requested, the manifest says so — that is the real test window; don't pad it.

## Step 3 — development run (first 75% of the timeline only)
```powershell
python -m bgbot.experiment dev
```
Writes `results/dev_report.md` (+ JSON, trade and equity CSVs). Every run is logged in
`results/variants.jsonl`; the count of distinct variants is printed in every report.

## Step 4 — only if dev passes: freeze, then open the holdout once
```powershell
python -m bgbot.experiment lock
python -m bgbot.experiment holdout
```
The holdout refuses to run if the config changed after `lock`, or if it has already been run.

## Pass/fail criteria (fixed now, before any real result exists)
| criterion | threshold | why |
|---|---|---|
| trades in holdout | ≥100 total and ≥30 per coin | fewer trades → expectancy standard error ≈ ±0.15–0.25R, so a "positive" result is noise |
| net expectancy | ≥ +0.10R per trade after base costs | thin edges are erased by the cost/latency gap between backtest and reality |
| stressed costs | expectancy > 0 with 2× costs **and** 1-bar delay | if doubling costs kills it, real execution will too |
| beats cash | net P&L > 0 | cash in USDT has no market risk (it still has exchange risk) |
| beats buy-and-hold on return/drawdown | return ÷ maxDD ≥ buy-and-hold's | otherwise holding is simpler and better |
| max drawdown (tier 1) | ≤ 10% | your stated objective is small losses |
| bootstrap drawdown, 95th pct | ≤ 20% | one historical path understates bad luck |
| profit concentration | best 5 trades < 50% of net profit | otherwise it's a few lucky trades |
| liquidations | 0 | any liquidation means sizing/leverage is wrong |
| dev walk-forward folds | ≥ 60% positive | edge must not live in one period |
| demo execution (milestone 3) | ≥4 weeks and ≥30 trades; median slippage ≤ 2× modeled; 0 unprotected positions > 10 s; 0 duplicate orders; 0 unreconciled mismatches | backtest assumptions must hold on the real exchange |

**Invalidation:** any failed holdout criterion → REJECT that variant. Tweaking parameters and
re-running the same holdout is not allowed; a revision is a new variant and needs new, unseen data
(e.g. wait 3–6 months of forward demo data).

## What the leverage experiments separate
* `exposure_tier_{1,2,3}x`: risk per trade, open-risk cap and notional cap all ×1/×2/×3 → more exposure.
  Reported with and without the drawdown halt.
* `leverage_setting_same_size`: identical position sizes; only the exchange **leverage setting**
  (isolated margin) changes 2/5/10/20/50×. P&L differs only through liquidations — the setting
  does not create returns, it only moves the liquidation price closer.

## Known simplifications (read before trusting any number)
All fills taker; slippage is a fixed bps term (no order-book depth); funding mapped to 4H bar opens;
liquidation uses tier-1 MMR and ignores funding drift; conservative "liquidated if mark breaches the
liquidation price in the bar, even if the stop also triggers". Exchange outages, ADL and withdrawal
freezes are not modeled.

## Next milestones (not in this zip)
2. Local paper broker driving `oms.OMS` with live public prices (no keys).
3. Bitget **demo** adapter (Demo API key, `paptrading: 1` header), verified field by field against
   the docs for your account mode (Classic vs Unified). Keys in environment variables, read-only +
   trade permissions, **withdrawal disabled**, IP-bound, never logged.
