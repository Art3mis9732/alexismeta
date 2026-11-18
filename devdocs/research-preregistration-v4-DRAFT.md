# DRAFT research-prereg-v4: cost-aware entry filter, confirmatory test. STATUS: NOT READY. Do not run.

## Why it is not ready
Every day of public history through 2026-11-17 has been looked at: K was selected on the first 70% and the last 30% was scored in v3 and again in the diagnosis. A wider K grid (8, 10, 12) on those data would be a new search over an examined period, not a test. The only genuinely independent chronological data is what accrues after 2026-11-18, which the forward worker is now recording (cost-filter shadow, schema v12, thresholds predeclared 2, 3, 4, 5, 6, 8, 10, 12).

## What must be true before running
1. **Independent data:** at least 130 days of continuous forward shadow (the worker running on a machine that stays on; gaps recorded, not filled), starting 2026-11-18 and frozen at a date set now. Estimate from replay rates: Balanced produces about 7 entry candidates per day, about 1.5 per day with a stop >= 4 x round-trip cost; 200 allowed-and-resolved candidates therefore take about 130 days (K=4) and about 290 days (K=6).
2. **Or a second independent universe** (e.g. other liquid Bitget perpetuals, same public endpoint): needs the analysts' rules to be instrument-agnostic and instrument specs added; not built, not assumed.

## Design (fixed now, so nothing is chosen after looking)
* Rule: block when stop bps < K x 16; one pre-declared K = 4 (the grid edge was 6 but 4 keeps more trades; chosen on cost arithmetic, not on v3's final results) plus K = 6 reported as sensitivity only. No search.
* Unit: net R per trade, fixed sizing, hypothetical outcome from stored 1m candles (`filter_shadow_outcomes`), costs taker 6 + 6 bps and slippage 2 + 2 bps plus a stated spread allowance.
* Comparisons: allowed vs blocked candidates (paired by day, day-block bootstrap), abstention (0 R), random thinning to the same count, and the unfiltered analyst.
* Criteria per analyst on the frozen forward window: C1 at least 200 allowed-and-resolved candidates; C2 allowed-minus-blocked mean R with a 95% interval above 0; C3 allowed mean R with a 95% interval above 0 and above random thinning's 95th percentile; C4 simulated fixed-size drawdown under 25 R. Three analysts: a Holm adjustment across them. Unresolved (gap) candidates are reported and excluded, never imputed; if more than 10% are unresolved the window is INCONCLUSIVE.
* Pass means candidate for a paper-trading filter **after explicit approval**; never automatic.
