# research-prereg-v3 (cost-aware entry filter for the analysts): REJECTED by the pre-registered criteria, with a useful descriptive finding

Run 2026-11-18 under `research-preregistration-v3.md` (committed before any filtered run; nothing changed afterwards). Evidence: `evidence/filter-v3-2026-11-18.json`. Window 2024-11-17 to 2026-11-17 (730 days), DEVELOPMENT until 2026-04-12, FINAL after it. No model was involved: the analysts' rules, risk gate, sizing and costs are unchanged and the filter only removes entries whose stop is nearer than K x 16 bps (the modelled round-trip cost).

## Registered outcome
| Analyst | Selected K (development only) | FINAL trades (filtered / unfiltered) | C1 (>= 200 trades) | C2 (improvement CI lower bound > 0) | C3 (edge) | Verdict |
|---|---|---|---|---|---|---|
| Risk Taker | 6 | 156 / 120 | no | yes (see caveat) | no | **REJECTED** |
| Balanced | 6 | 153 / 1,317 | no | yes | no | **REJECTED** |
| Defensive | 6 | 17 / 601 | no | no | no | **REJECTED** |
All three analysts picked the **largest K in the registered grid (6)**, which cut the final-segment trade count below the registered 200-trade minimum. The registered rule is applied as written: REJECTED. The grid is not extended after seeing this.

## Descriptive results (mean net R per trade; not part of the verdict)
| Balanced | K=0 | K=2 | K=3 | K=4 | K=5 | K=6 |
|---|---|---|---|---|---|---|
| Development R / trades | -0.297 / 3,847 | -0.210 / 2,759 | -0.160 / 1,976 | -0.142 / 1,399 | -0.158 / 981 | -0.124 / 710 |
| Final R / trades | -0.387 / 1,317 | -0.248 / 894 | -0.182 / 547 | -0.135 / 340 | -0.115 / 229 | **+0.056 / 153** |
* The same monotone pattern appears for the Risk Taker (development -0.355 to -0.103, final -0.553 to -0.022) and, less cleanly, for the Defensive analyst (-0.288 to -0.159 in development; its final trades fall to 17, too few to say anything).
* **Balanced, final segment, K=6:** mean +0.056 R per trade, but the 95% CI for the filtered mean is [-0.129, +0.234] (includes zero), and the paired improvement over unfiltered is +0.44 R per trade with CI [0.26, 0.63]. Total over the final segment: about -510 R unfiltered (1,317 trades) versus about +9 R filtered (153 trades; CI roughly -20 to +36 R).
* **Caveat (Risk Taker):** its unfiltered final segment has only 120 trades because that no-suspension account has been compounded to almost nothing by then (minimum-notional rejections), so its "unfiltered" comparator is not comparable and its improvement figure is unreliable. Balanced is the clean comparison.
* The random-entry comparison for C3 is uninformative at these trade counts (random runs with about 150 trades have a huge spread; their 95th percentile was above 1 R).

## What it means
1. **Cost is a large, avoidable part of the analysts' loss.** Skipping entries whose stop is under about six times the round-trip cost (about 96 bps) moves Balanced from about -0.4 R to about break-even per trade, at the price of taking about 12% as many trades. The loss per trade falls monotonically as the filter tightens, in development and final alike, which is what the cost arithmetic predicts.
2. **It is a loss-avoidance rule, not an edge.** The filtered result is statistically indistinguishable from zero, the gross result before costs is about zero (audits), and the filter reaches break-even by trading rarely. Nothing here supports turning it on, and nothing in it makes the analysts profitable.
3. **The registered grid ended at the optimum's edge**, which is a design flaw: the criteria required 200 trades while the best-looking K is the one that removes most of them. A follow-up must be a new pre-registration (v4) with, for example, a larger K grid (8, 10, 12), a trade-count criterion matched to the expected volume, and a fresh final segment (the last 30% is spent for this question, and the earlier part cannot serve as a final segment because K was chosen on it).
4. Forward shadow comparison is the cleanest next evidence: record what a K=4 to 6 filter WOULD have blocked on the live analysts' setups (the news shadow table already works this way) and compare outcomes as forward data accumulates. Nothing changes any active analyst.
