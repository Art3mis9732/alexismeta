# Stress detector calibration and evaluation (stress-v1, 2026-11-17)

Reproduce: `node scripts/stress_fetch_1m.js 90` (public Bitget history endpoint, free, rate-limited) then `node scripts/stress_calibrate.js --out devdocs/evidence/stress-calibration-2026-11-17.json`. Raw data lives in `data/hist/` (gitignored); the evidence JSON is committed.

**Status: PROVISIONAL.** Modest evidence from one 30-day evaluation period for the price/volatility/volume families; **the liquidity families (spread, depth) have no historical basis at all** and are shadow-only. No accuracy figure is claimed or produced.

## Method

* Data: 90 days of 1m USDT-perp candles for BTC, ETH, XRP (129,600 rows each, **0 missing**), 2026-08-19 to 2026-11-17.
* Development period: 2026-08-20 to 2026-10-18 (59 days after a 24 h baseline warm-up). Thresholds = the 99.5 / 99.9 / 99.97th percentiles of each metric over the development period, pooled across the three instruments, rounded to one decimal. **Chosen on development data only.**
* Evaluation period: 2026-10-18 to 2026-11-17 (30 days). **It was scored three times, not once:** (1) with unrounded thresholds; (2) after I added the move-onset latency label, which I added *because* the first scoring showed a delay figure that was an artefact of the forward-window label; (3) with the rounded shipped thresholds (the evidence file is this final run). The thresholds are development-period quantiles throughout and were never tuned on evaluation results, but the evaluation design changed after a first look, so the evaluation month is **not a pristine holdout**. A genuinely untouched test needs a later period (the forward SHADOW record).
* Shipped thresholds (`server/stress.js`): P (move vs noise, robust z) [8.6, 13.9, 19.3], V (realised-vol ratio) [4.7, 8, 10.3], A (volume z, confirms only) [3.2, 4]. Liquidity S, D: engineering values, **not calibrated**.
* Labels the detector does not compute: (1) ABNORMAL FORWARD RANGE: the next-60-minute realised range (max high − min low) ≥ the 99th percentile of that instrument's development distribution (cut-offs: BTC 2.09%, ETH 2.94%, XRP 4.67%). (2) ABNORMAL 15-MINUTE MOVE: |15-minute log return| ≥ the development 99.9th percentile of |15m return| (absolute, not volatility-normalised). Used for latency.
* The state machine runs on a 60 s grid here (5 s live, 30 s persistence): live will alert somewhat MORE often. Baselines are refreshed hourly here (every minute live).

## Results on the untouched evaluation month

| | BTC | ETH | XRP |
|---|---|---|---|
| Alert episodes per day (any state above NORMAL) | 0.935 | 1.068 | 0.534 |
| Share of time in HIGH_STRESS or CRITICAL (the restricted states) | 0.658% | 0.883% | 0.338% |
| Base rate of an abnormal forward range (all minutes) | 1.9% | 1.8% | 0.3% |
| Abnormal forward range, given state NORMAL | 1.8% of 42375 min (95% CI 1.7%–1.9%) | 1.6% of 42147 min (95% CI 1.5%–1.8%) | 0.4% of 42716 min (95% CI 0.3%–0.4%) |
| Abnormal forward range, given state ELEVATED | 9.1% of 481 min (95% CI 6.9%–12.1%) | 7.2% of 612 min (95% CI 5.4%–9.5%) | 0.0% of 278 min (95% CI -0.0%–1.4%) |
| Abnormal forward range, given state HIGH_STRESS | 5.7% of 140 min (95% CI 2.9%–10.9%) | 10.4% of 297 min (95% CI 7.5%–14.4%) | 0.0% of 112 min (95% CI 0.0%–3.3%) |
| Abnormal forward range, given state CRITICAL | 0.0% of 144 min (95% CI 0.0%–2.6%) | 3.6% of 84 min (95% CI 1.2%–10.0%) | 0.0% of 34 min (95% CI 0.0%–10.2%) |
| Abnormal 15-minute moves in the period / alerted at some point | 12 / 9 | 10 / 10 | 3 / 3 |
| Delay from the START of the 15-minute move to the first alert, median / p90 (min) | 12 / 26 | 15 / 22 | 12 / 23 |
| Forward-range episodes (≥ top-1% hours) / alerted | 14 / 4 | 14 / 6 | 5 / 0 |
| Alert episodes NOT followed by such a range | 24 of 28 | 26 of 32 | 16 of 16 |

Sensitivity (evaluation month; all thresholds scaled):

| scale | BTC alerts/day, restricted %, missed forward-range episodes | ETH | XRP |
|---|---|---|---|
| x0.8 | 1.702/day, 1.841%, missed 50.0% | 1.936/day, 2.397%, missed 28.6% | 1.168/day, 0.844%, missed 100.0% |
| x1.25 | 0.3/day, 0.329%, missed 92.9% | 0.434/day, 0.262%, missed 71.4% | 0.2/day, 0.118%, missed 100.0% |
| x1.5 | 0.067/day, 0.199%, missed 92.9% | 0.267/day, 0.199%, missed 92.9% | 0.167/day, 0.065%, missed 100.0% |

## What this does and does not show
* **BTC and ETH:** an abnormal 60-minute forward range followed ELEVATED about 4-5 times as often as the base rate in the evaluation month (intervals above). That is real but modest predictive lift on one month with few independent episodes (labels overlap, so the intervals are optimistic).
* **XRP: no lift demonstrated** (0 abnormal forward ranges in 424 alert minutes; base rate 0.35% in this month). It had a strong CRITICAL signal in the development period, which did not carry over: a reminder that a single period proves little.
* **Severity is not monotonic** in the results (for BTC, HIGH is below ELEVATED; CRITICAL had few minutes). More states do not mean more predictive information here. The rules stay as documented but should not be read as a calibrated scale.
* **The detector reacts to moves; it does not anticipate them.** Measured from the start of an abnormal 15-minute move, BTC/ETH alerts arrive a median of 12-15 minutes in, i.e. near the end of the move; p90 22-26 minutes. The 30 s persistence rule is not the bottleneck: the move must first grow past the threshold. `maxDetectionDelayMs` (60 s) is only the delay from first threshold exceedance to a confirmed state.
* **Most alert episodes are not followed by a top-1% range** (the label is rare): expect false alerts to dominate by count. Time in the restricted states is small (about 0.3-0.9%).
* **Liquidity families are unevaluated.** No historical order book exists; the monitor now records per-minute spread/depth samples so a baseline accumulates, and the forward SHADOW record will be the first evidence.
* One 30-day period, three highly correlated assets, one set of labels. No claim about other regimes, no profitability claim, no accuracy percentage.

## Decision
Keep the policy in **SHADOW**. Enforcing it changes forward behaviour and needs the user's explicit approval plus a recorded effective time (D-024). The detector is a monitoring and research tool at this stage.
