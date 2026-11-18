# research-prereg-v2 (wider stops / longer bars): both candidates REJECTED on validation

Run 2026-11-18 under `research-preregistration-v2.md`, whose criteria, grid and gate are those of v1 and were not changed. Manifests and splits were committed before any fit (`research/registry/v2A`, `v2B`). **The final segments were never read.** Nothing was promoted. Evidence: `evidence/model-audit-v2A-2026-11-18.json`, `evidence/model-audit-v2B-2026-11-18.json`; trial logs in `research/registry/v2A|v2B/trials.jsonl` (21 trials each).

## Setup recap
Same 2 years of Bitget candles (BTC/ETH/XRP), same 21 candle-derived features, same costs (taker 6 bps + 2 bps slippage per leg, one-tick spread), same split rule. **A:** stop 2.0 x ATR(15m), target 3.0 x ATR, 24 h hold, decisions every 15 minutes (404,874 rows). **B:** stop 1.0 x ATR(1h), target 1.5 x ATR(1h), 24 h hold, hourly decisions (101,226 rows).

## What changed economically (train rows, measured)
| | v1 (15m, 1 ATR) | A | B |
|---|---|---|---|
| Mean cost per trade | 0.463 R | 0.231 R | 0.207 R |
| Gross result before costs | -0.001 R | -0.004 R | -0.002 R |
| Unconditional net | -0.464 R | -0.236 R | -0.209 R |
| Break-even win probability | 58.5% | 49.3% | 48.3% |
| Base win rate | 39.4% | 39.9% | 40.0% |
**Costs halved, as predicted; gross is still zero.** The unconditional template trade is a fair bet before costs at every scale tested.

## Result
| | A | B |
|---|---|---|
| Configurations fitted (same grid as v1) | 21 | 21 |
| Best validation log-loss gain over the base rate | 0.0000 (no model beat the constant) | 0.0000 |
| Label-shuffled control | -0.0001 | +0.0001 (about 0, no leakage signal) |
| Verdict | **REJECTED_ON_VALIDATION** | **REJECTED_ON_VALIDATION** |
In v1, boosting beat the base rate by 0.005 in log loss, but only by predicting the cost term. With the cost tail gone (target hits that still net <= 0 are 0.02% of rows in A and 0.0% in B) **no model, linear or boosted, beats the base rate at all**: the v1 gain really was the cost effect, and it disappears when costs are small.

## What the validation-only audit says about gross edge
* Correlation of predicted probability with gross R: up to 0.043 in magnitude (v1: up to 0.01); every sign and size is consistent with noise.
* The most confident 1% of rows: 10 of 20 models have positive gross R in A (best +0.19 R over 798 rows, cost 0.29, net -0.10) and 6 of 20 in B (best +0.28 R over 200 rows, cost 0.26, net +0.03). The most confident 10% of rows have gross about -0.12 to +0.06 R. The B figure is one configuration out of 20, on 200 heavily overlapping rows, net +0.026 R: **not distinguishable from selection among noisy options and not a result**; it is recorded here, not used.
* No claim of edge. The pre-registered rule (a configuration must beat the base rate's log loss) stops here by design, and FINAL stays unread.

## What this means
1. **The cost problem is real but it was never the root cause.** Halving costs moved the unconditional net from -0.46 R to about -0.22 R, still negative because the gross result is zero. A model has to find a gross edge of at least 0.2 R in the rows it selects; none finds one.
2. **Wider stops / longer bars do not make these features predictive.** 21 candle-derived features at 15-minute to 1-hour scale carry no usable information about the sign of the next 24 hours' move beyond costs, at least for a classifier on net outcome.
3. The 15-minute rule analysts are consistent with this (Slice 1: break-even before costs).
4. v2 is closed. Do not retune A or B on this data.

## Next hypotheses (each needs its own pre-registration; none started)
* **Different information, not different horizons:** funding, open interest, order-book imbalance, and news/event features. The forward worker records order-book tops and funding and is accumulating news since 2026-11-16, but only days of it exist; weeks are needed.
* **Cost-aware filter as a rule for the existing analysts** (skip entries whose stop is small versus the round-trip cost). It cannot create edge; at best it removes the most expensive losing trades. Worth a small pre-registered test with the Slice 1 harness.
* **A regression target (expected gross R) instead of a net-win classifier**, to avoid scoring models on the cost term; pre-register before looking.
* **Maker (limit) entries** would roughly halve fees but add fill uncertainty that candles cannot measure.
