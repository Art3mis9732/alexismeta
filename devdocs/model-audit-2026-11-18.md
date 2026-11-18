# Why all 21 validation-stage models failed (audit, 2026-11-18)

Reproduce: `python -m modellab.audit` (TRAIN and VALIDATION rows only; the final segment is never read). Evidence: `evidence/model-audit-2026-11-18.json`. Registry: `research/registry/trials.jsonl`.

## 1. What the 21 actually were
Not 21 independent ideas: **21 configurations of four model families (one is the constant reference) on one dataset, one target and one trade template.**
* **Dataset** `dataset-v1`, sha256 `205a589aac1f…`: BTC/ETH/XRP perpetuals, 15-minute decision bars, 2 years of public Bitget candles, rows = coin x bar x side (225,546 train, 80,166 validation). Train 2024-12-04 to 2025-12-31; validation 2026-01-03 to 2026-05-23; final segment unread.
* **Target (all 21):** `y = 1` if the template trade nets more than zero after costs. **Template (all 21):** entry at the bar close, stop 1.0 x ATR(14, 15m), target 1.5 x ATR, 8-hour time exit, taker 6 bps + slippage 2 bps on each leg, spread one tick (the best case), no funding (an 8 h hold; only 90 days of funding history exist). Exits resolved on 1-minute candles.
* **Features (all but the legacy comparator):** 21 candle-derived values (trend, VWAP distance, ATR %, ATR percentile, 24 h change, 24 h realised volatility, trigger counts, returns over 1/4/16/96 bars in ATR units, range position, volume ratio, hour of day). No order book, news, open interest or funding.
* **Families:** constant base rate (1), legacy-style logistic regression on 8 returns/volatility/volume/time features (3), L2 logistic regression on all 21 features (5), shallow histogram gradient boosting (12; depth 2-3, 50-200 trees, leaf 500 or 2000). Selection: log loss on validation versus the training base rate; a trade-level decision needed a threshold of 0.50 or more.

## 2. Result per configuration (validation segment)
"Top 1%" = the 1% of validation rows each model was most confident about. Gross R = the template trade's result before any cost; cost R = fees plus slippage in R.
| # | Family | Parameters | Log-loss gain vs base | Max predicted p | Rows with p >= 0.50 | Top 1%: gross R | Top 1%: cost R | Top 1%: net R | Correlation of p with gross R |
|---|---|---|---|---|---|---|---|---|---|
| 1 | constant | - | +0.0000 | 0.394 | 0 | - | - | - | - |
| 2 | legacy_lr | C: 0.01 | -0.0007 | 0.488 | 0 | +0.013 | 0.321 | -0.308 | -0.009 |
| 3 | legacy_lr | C: 0.1 | -0.0007 | 0.488 | 0 | +0.013 | 0.321 | -0.309 | -0.009 |
| 4 | legacy_lr | C: 1.0 | -0.0007 | 0.488 | 0 | +0.013 | 0.321 | -0.309 | -0.009 |
| 5 | lr | C: 0.001 | -0.0008 | 0.534 | 27 | -0.024 | 0.272 | -0.296 | -0.004 |
| 6 | lr | C: 0.01 | -0.0009 | 0.538 | 36 | -0.034 | 0.290 | -0.324 | -0.003 |
| 7 | lr | C: 0.1 | -0.0009 | 0.538 | 37 | -0.031 | 0.291 | -0.322 | -0.003 |
| 8 | lr | C: 1.0 | -0.0009 | 0.538 | 38 | -0.031 | 0.291 | -0.322 | -0.003 |
| 9 | lr | C: 10.0 | -0.0009 | 0.538 | 38 | -0.031 | 0.291 | -0.322 | -0.003 |
| 10 | hgb | max_depth: 2, max_iter: 50, min_samples_leaf: 500, learning_rate: 0.05 | +0.0053 | 0.457 | 0 | -0.018 | 0.491 | -0.509 | -0.004 |
| 11 | hgb | max_depth: 2, max_iter: 50, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0052 | 0.427 | 0 | -0.090 | 0.530 | -0.621 | -0.005 |
| 12 | hgb | max_depth: 2, max_iter: 100, min_samples_leaf: 500, learning_rate: 0.05 | +0.0056 | 0.514 | 3 | -0.005 | 0.381 | -0.386 | -0.004 |
| 13 | hgb | max_depth: 2, max_iter: 100, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0055 | 0.450 | 0 | -0.003 | 0.383 | -0.387 | -0.005 |
| 14 | hgb | max_depth: 2, max_iter: 200, min_samples_leaf: 500, learning_rate: 0.05 | +0.0054 | 0.573 | 50 | -0.056 | 0.335 | -0.390 | -0.003 |
| 15 | hgb | max_depth: 2, max_iter: 200, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0055 | 0.487 | 0 | +0.056 | 0.383 | -0.326 | -0.002 |
| 16 | hgb | max_depth: 3, max_iter: 50, min_samples_leaf: 500, learning_rate: 0.05 | +0.0053 | 0.494 | 0 | -0.095 | 0.432 | -0.527 | -0.003 |
| 17 | hgb | max_depth: 3, max_iter: 50, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0052 | 0.453 | 0 | +0.030 | 0.392 | -0.362 | -0.003 |
| 18 | hgb | max_depth: 3, max_iter: 100, min_samples_leaf: 500, learning_rate: 0.05 | +0.0055 | 0.539 | 15 | -0.026 | 0.353 | -0.379 | -0.003 |
| 19 | hgb | max_depth: 3, max_iter: 100, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0055 | 0.485 | 0 | +0.034 | 0.419 | -0.385 | -0.002 |
| 20 | hgb | max_depth: 3, max_iter: 200, min_samples_leaf: 500, learning_rate: 0.05 | +0.0053 | 0.592 | 152 | -0.003 | 0.368 | -0.370 | +0.001 |
| 21 | hgb | max_depth: 3, max_iter: 200, min_samples_leaf: 2000, learning_rate: 0.05 | +0.0055 | 0.535 | 60 | +0.048 | 0.419 | -0.371 | +0.002 |

Not one configuration has a clearly positive gross result in its most confident rows (the best is +0.056 R, about the size of sampling noise), and the correlation between predicted probability and gross R is within 0.01 for every model.

## 3. Where the money goes (the cost-to-risk problem, quantified)
| Measure (template trade, per trade) | Train | Validation |
|---|---|---|
| Gross result before any cost (frictionless) | -0.0010 R | -0.0121 R |
| Cost: fees (6 bps taker x 2, in R; approximate) | 0.347 R | - |
| Cost: slippage and rounding (approximate) | 0.116 R | - |
| **Total cost** | **0.463 R** | **0.509 R** |
| **Net result** | **-0.464 R** | **-0.521 R** |
| Win rate after costs / target-before-stop rate | 39.4% / 39.6% | 38.8% / - |
| Win probability needed to break even at that cost | 58.5% | 60.3% |

Cost per trade by quietness (validation): cheapest bin 0.16 R (net -0.14), middle 0.42 R (net -0.44), most expensive 1.54 R (net -1.51, win rate 25%). Gross R is about zero in every bin.

## 4. Diagnosis
Candidate causes from the brief, answered with the numbers above:
1. **Unprofitable predictive signal: yes, and it is the root.** Without costs the template trade earns -0.001 R (a fair bet: a 1.0/1.5 barrier on a random-walk-like price wins about 40% and averages zero), and no model finds rows where that changes: gross R in any model's most confident rows stays between about -0.1 and +0.06 R, and correlations with gross R are about zero. Boosting's log-loss gain is real but comes from predicting the cost term (correlation with cost R about -0.5), not direction.
2. **Excessive trading costs: yes, the reason the result is negative rather than flat.** Round-trip cost is 0.46 R: fees about 0.35 R, slippage about 0.12 R. The stop is 1 ATR of a 15-minute bar, about 44 bps of price, against about 16 bps of costs.
3. **Poor execution assumptions: no, if anything optimistic.** Spread was one tick and depth unlimited; real fills can only be worse. Taker on both legs is the live engine's assumption.
4. **Poor risk/reward design: yes, as an interaction.** A tight stop in R terms makes a fixed-bps cost large; the 1.5 reward-to-risk then needs a 58-60% win rate against a 39% base.
5. **Trade frequency: not the cause of the model failures** (the models took almost no trades), but it multiplies cost for the rule analysts (Slice 1: about 7 trades a day each paying roughly 0.35 R).

Primary = (1) no signal; the cost structure (2 + 4) decides how much signal would be needed: at 0.46 R per trade a model would need a gross edge of about that size in its selected rows, ten times anything observed.

## 5. What this says about the next experiment (wider stops / longer bars)
* Wider stops or longer bars **reduce the cost in R** (ATR in bps grows with the bar length while fees stay about 16 bps): roughly 0.46 R at 15 m, about 0.23 R at 1 h and about 0.12 R at 4 h if ATR scales with the square root of time. That lowers the hurdle; it **does not create signal**. Expect REJECTED unless a model's gross edge at those horizons exceeds roughly 0.1-0.25 R.
* Wider stops alone do not solve this and I will not claim they do: the experiment tests whether longer horizons carry a gross edge that the 15-minute horizon does not.
* Further hypotheses, each needing its own pre-registration: (a) a cost-aware entry filter (skip when cost R is high), which would remove the 9,570 validation rows costing more than 0.8 R; (b) funding, order-book and open-interest features once the forward worker has recorded enough.
