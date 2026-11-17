# First real fit under research-prereg-v1: REJECTED on validation

Run 2026-11-17, `python -m modellab.validate` on `data/research/dataset-v1` (manifest sha256 `205a589a…`, committed in `research/registry/dataset-v1-manifest.json` before the fit). 32 of 40 allowed trials logged (`research/registry/trials.jsonl`, nothing hidden). **The final segment was never read.** Nothing was promoted; nothing in the live system changed.

## Data
2 years of public Bitget candles (BTC/ETH/XRP, 15m and 1m, 0 gaps), 406,404 rows (coin x bar x side). Train 2024-12-04 to 2025-12-31 (225,546), validation 2026-01-03 to 2026-05-23 (80,166), final 2026-05-26 to 2026-11-17 (100,692, untouched). 3-day embargo between segments; labels whose 8-hour window crossed a boundary were dropped.
The template trade (1 ATR stop, 1.5 ATR target, 8 h time exit, 6 bps taker plus 2 bps slippage per leg) has a mean cost of **0.46 R per trade** in the training segment, so an unconditional entry loses about **-0.46 R** and wins 39.4% of the time; break-even needs about **58% wins**.

## Result
| Family | Configurations | Validation log loss vs the base rate | Verdict |
|---|---|---|---|
| Constant base rate | 1 | 0.6679 (reference) | - |
| Legacy-style LR (returns, ATR %, volume, time) | 3 | worse by 0.0007 | no skill |
| L2 logistic regression, all features | 5 | worse by 0.0008 to 0.0009 | no skill |
| Shallow gradient boosting | 12 | **better by 0.0052 to 0.0056, consistently** | see below |
The label-shuffled control gives -0.0001 (no leakage signal). Boosting was the only family above the pre-registered margin, so it was taken to the threshold stage: with the decision threshold grid 0.50 to 0.70, the model produced **1 validation trade in total** (its largest predicted win probability is 0.51) and no threshold had the 100 trades required. Result: **REJECTED_ON_VALIDATION**.

## Why boosting's log-loss gain is not an edge (exploratory, validation rows only, not part of the gate)
The gain is real but it is not directional skill. Its predicted probability correlates -0.54 with the trade's cost in R, and the win rate collapses from 39% to 25% in the highest-cost bin (cost above 1.2 R, i.e. very quiet markets where a 1.5 ATR target cannot beat 16 bps of costs). The model learned "do not expect a win when costs eat the target", which is true and tradable as a *filter* but not as an entry signal: the 10% of rows with the highest predicted probability still lose -0.53 R on average (win rate 38%), no better than the average row (-0.52 R). Even in the cheapest cost bin (about 0.16 R) the result is -0.14 R. Trend direction alone separates nothing (-0.49, -0.54, -0.53 R).

## What this means
* With this template (a 15-minute bar, a 1 ATR stop) the round-trip cost is about half of the risk taken on every trade, and none of the 21 candidate models, from regularised logistic regression to shallow boosting, finds rows that overcome it. This agrees with Slice 1: the three rule analysts are break-even before costs and about -0.35 R after.
* The boosting finding is useful, not a trading rule: **market quietness predicts that costs will dominate**. A cost-aware filter (do not enter when the stop distance is too small relative to the round-trip cost) is a plausible rule improvement to test on its own, in a new pre-registered version; whether the live gate already covers it has not been checked here.
* No claim of edge, no shadow candidate, no promotion. The registry shows REJECTED_ON_VALIDATION.

## Options for the next pre-registration (v2), for the user to choose; none started
1. **Wider template** (longer bar such as 1 h or 4 h, or a 2 to 3 ATR stop) so costs are a smaller share of risk. Cheapest, directly addresses the cost ratio; needs its own fresh final segment.
2. **Cost-aware entry filter** applied to the existing analysts (a rule, not a model), evaluated by the Slice 1 harness.
3. **Maker (limit) entries**: halves fees but adds fill uncertainty that candles cannot measure; needs forward order-book recording.
4. **More inputs** (order-book imbalance, funding, news) once the forward worker has recorded enough: needs weeks of forward data.
The final segment of v1 stays unread; if v1 is ever scored it must follow the registered procedure exactly.
