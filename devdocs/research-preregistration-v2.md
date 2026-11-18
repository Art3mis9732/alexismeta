# Pre-registration research-prereg-v2: wider stops / longer bars

**Committed before any v2 dataset is built and before any v2 model is fitted.** It is a NEW version: v1 (15-minute, 1 ATR stop) stays REJECTED_ON_VALIDATION with its final segment unread, and nothing here reopens it. The acceptance gate, costs, features, split fractions, embargo, trial grid and trial-accounting rules are **unchanged from research-prereg-v1 (sections 2 to 6 and Amendments 1 and 2)**; only the trade template differs. No criterion is changed after any result.

## 0. Why this experiment, and what the audit says to expect
`model-audit-2026-11-18.md`: the v1 template earns about 0 R before costs, costs 0.46 R (about 0.35 fees, 0.12 slippage), so it needs a 58-60% win rate against a 39% base; no model found gross edge (best top-1% gross +0.06 R, correlation of p with gross R within 0.01). Longer stops or bars lower the cost in R but create no signal. **Expectation: REJECTED.** The experiment answers one question: does any model find a gross edge at these horizons larger than the (lower) cost? Wider stops alone are not assumed to help.

## 1. Two candidates, attributable separately (no combined candidate C)
Same instruments, features (21, unchanged), costs (taker 6 bps + slippage 2 bps per leg, spread one tick, entry at the bar close reference, exits resolved on 1-minute candles with the stop winning a tie), label (`y = 1` if the template trade nets more than zero after costs; netR and costR stored), model families and grid, and split rule (55/20/25 time split, 14-day burn-in, 3-day embargo, label windows purged at boundaries).
| Candidate | What changes versus v1 | Decision cadence | Stop / target (reward:risk 1.5 as before) | Time exit |
|---|---|---|---|---|
| **A: wider stop** | stop and target distances doubled, hold up to 24 h | every 15-minute bar close | stop 2.0 x ATR(14, 15m); target 3.0 x ATR(14, 15m) | 96 bars (24 h) |
| **B: longer bars** | the bar scale of the stop moves to 1 hour and decisions become hourly | at each UTC hour close | stop 1.0 x ATR(14, **1h**); target 1.5 x ATR(14, 1h); ATR(1h) is Wilder's average true range of the 15-minute data aggregated into complete UTC-hour bars | 96 bars (24 h) |
A isolates the stop distance at the same cadence; B isolates the decision/bar scale (roughly the same stop distance as A, with a quarter of the decisions, so less overlap). A 4-hour bar is **excluded**: an 8 to 96 hour hold crosses many funding settlements and only 90 days of funding history exist, so the cost could not be measured honestly.
Funding is not modelled for A or B (24 h holds cross at most three settlements, typically about 1 bp each): this is a disclosed bias, and the result tables must add a funding sensitivity line (1 bp adverse per 8 h held).

## 2. Hypotheses and expected cost
H-A and H-B: a model's selected trades have mean net R per trade above zero on the final segment under the v1 gate. Expected mean cost: about 0.23 R (A) and 0.23 R (B) versus 0.46 R in v1 (to be measured, not assumed); break-even win rate about 49%.

## 3. Procedure (unchanged mechanics, per candidate in its own registry directory)
1. Build the dataset; write `split.json` and the manifest; **commit them before any fit**.
2. `modellab.validate`: 21 configurations plus the threshold grid for the one selected configuration: at most 32 trials per candidate (cap 40); label-shuffled control; REJECTED_ON_VALIDATION (final unread) if nothing clears the margin or the best threshold has no positive validation mean R with at least 100 trades.
3. If selected: one-time FINAL scoring with the v1 five-part gate (at least 300 trades; day-block CI lower bound above 0; above the 95th percentile of 200 random entries with the same trade count and the same template; positive in at least 2 of 3 coins and both halves; positive with costs +25%).
4. Because two candidates are evaluated, a marginal pass must be reported with that fact; the criteria are not tightened or loosened.

## 4. What a pass or a fail means
Pass: a candidate for forward SHADOW evaluation only; never promoted, never trades. Fail: recorded as REJECTED, with the audit-style gross/cost decomposition, and the next hypothesis named (cost-aware entry filter; funding/order-book/open-interest inputs once recorded). No retuning on a failed FINAL.

## Pre-fit record (2026-11-18, before any v2 model was fitted)
Datasets built from the same 2-year public candles (manifests and splits committed in `research/registry/v2A` and `v2B` before the first fit). v2A: 404,874 rows (train 224,952 / validation 79,710 / final 100,212), matrix sha256 `ba4f55ca…`. v2B: 101,226 rows (56,238 / 19,932 / 25,056), sha256 `2b6da200…`.
Label check on TRAIN rows only (advisor review): target hits that still net <= 0 after costs are 0.02% of rows in A and 0.0% in B (it was the high-cost tail in v1 that let boosting score by predicting cost). The registered label is therefore kept unchanged. Measured costs: mean 0.231 R (A) and 0.207 R (B); unconditional net -0.236 R and -0.209 R; gross -0.004 R and -0.002 R; break-even win probability 49.3% and 48.3% against a 39.9% base.
Disclosure: A and B are close to the same bet (ATR(1h) is about twice ATR(15m)); they are treated as one family when reading results, and no criterion changes because two were run. If either reaches FINAL, that calendar period is spent for this feature set.
