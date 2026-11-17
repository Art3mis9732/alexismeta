# Historical evaluation of the three analysts (research Slice 1)

Status: **descriptive, rules frozen, nothing tuned on this data.** Evidence: `devdocs/evidence/hist-eval-2026-11-17.json` (full numbers), `hist-parity-2026-11-17.json`, `hist-fill-comparison-2026-11-17.json`.
Code: `research/*.js` (public candles only, no network at run time, no database writes). Tests: `tests_js/research_harness.test.js` (synthetic data, mutation-verified, D-023).
Reproduce: `node research/fetch_native.js 180 && node scripts/stress_fetch_1m.js 180 && nice node research/run_eval.js --seeds 10 --out devdocs/evidence/hist-eval-<date>.json` (about 2 min).

## 1. Headline
**On 180 days of BTC/ETH/XRP history, none of the three rule-based analysts makes money after costs, and none beats a random-entry baseline.** Before any cost the rules are about break-even; fees and slippage turn that into a loss of roughly 0.35 R per trade for every analyst. This is a no-edge result, reported as such. It is consistent with the forward ledger (no edge demonstrated) and with the legacy simulator's adverse result; it is **not** a proof that no edge exists, only that these three rule sets, as frozen, do not have one in this window.

## 2. What was replayed
* Window 2026-05-21T13:00Z to 2026-11-17T12:45Z, 180.0 days, 16,980 decision bars per coin (15m), 1,000 USDT per analyst, one portfolio per analyst across the three coins.
* The **live** decision code (`policies.decide`), the **live** risk gate and sizing (`risk.evaluate`/`sizePosition`, default limits) and the live engine's cost and exit rules (taker 6 bps both legs, 2 bps slippage each side, stop filled at the worse of stop and observed price, funding from the public history). Stop/target order inside a bar is resolved with **1-minute candles**.
* Variant **candle-only-v1**: every candle-derived field comes from the same code as live (`evidence.js`), point-in-time. Microstructure has no history, so it is assumed benign (spread one tick, depth sufficient, feeds healthy). Results are therefore an **upper bound** on what the rules could do live.

## 3. Validation before any number was trusted
| Check | Result |
|---|---|
| Exchange-native 15m bars vs 1m aggregated to 15m, 17,279 overlapping bars per coin | OHLC identical (0 differing bars); volume differs by at most 3e-5 relative |
| Gaps in the downloaded history | 0 in native 15m and 0 in 1m for all three coins |
| Evidence parity: 48 recorded forward snapshots vs the same bar rebuilt from history | all candle-derived fields and triggers identical (0 mismatches) |
| Decision parity: 126 recorded forward decisions (with recorded context) vs `decide()` on the rebuilt snapshot | 126/126 identical intent and code; 18 older decisions had no recorded context and were skipped |
| Fill parity: 10 closed forward positions vs the replay's exit rule on 1m candles | exit reason matches 10/10 and the exit minute matches (stops at the stop price vs the live first-observed price, difference a few bps). **All 10 had a trade-feed gap (the engine itself calls them uncertain), so this is a comparison, not a validation**; verdict `NO_EVALUABLE_SAMPLE`. The three 11:11 closures show the known worker-down incident (live exit later than the candle) |

## 4. Results (primary mode: account-level suspensions OFF, so the whole window is evaluated)
| Analyst | Trades | Win rate | Net USDT | R per trade | Profit factor | Before fees and slippage | Fees | Slippage | Day-block 95% CI of net | Random entry (10 seeds) p5 / median / p95 | Trend-always |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Risk Taker | 1,642 | 31.9% | -923.7 | -0.365 | 0.465 | +46 | 727 | 243 | [-1115, -729] | -910 / -891 / -855 (1,400 trades) | -992 (3,950 trades) |
| Balanced | 1,293 | 37.0% | -676.0 | -0.353 | 0.435 | +36 | 534 | 178 | [-794, -555] | -632 / -593 / -531 (1,067 trades) | -929 (3,536 trades) |
| Defensive | 480 | 39.4% | -143.5 | -0.331 | 0.434 | 0 | 108 | 36 | [-183, -105] | -166 / -129 / -115 (433 trades) | -568 (2,627 trades) |
No-trade baseline: 0. "Before fees and slippage" = gross P&L + slippage cost (price moves alone). The share of bootstrap resamples with a positive total is 0 for all three.
* **Equity-path caveat:** USDT figures compound on a shrinking account (Risk Taker ends near zero, so later thirds look "better" in USDT: -494, -318, -112). Use R per trade for comparison across time; it stays negative in every third (-0.26 to -0.44 R; no third is positive for any analyst).
* **By asset:** all three coins lose for every analyst; BTC is the worst (about -0.41 to -0.45 R), ETH and XRP about -0.24 to -0.35 R. By direction: LONG and SHORT lose about the same. No sub-group is positive (breakdowns are in the JSON; none was selected after the fact).
* **Live-rules mode (what the live paper account would do):** with the 5%-from-peak drawdown suspension, Risk Taker takes 20 trades, Balanced 54, Defensive 149, and the account then sits suspended (2,567 / 2,203 / 430 rejected setups). The earlier 90-day smoke run's "+16.9 USDT for Risk Taker" was this suspension truncating the window to its first weeks, not skill; it is withdrawn.
* **Stress gate (stress-policy-v1 on price/volume families only, no historical depth):** blocked about 2% of setups (32 / 21 / 4 trades); net -918.9 / -670.1 / -141.3 vs ungated -923.7 / -676.0 / -143.5. It changes nothing material in this window. This is not evidence for or against enforcing it: the gate exists to prevent unusable-data entries, which candle history cannot show.

## 5. Why they lose
* Gross P&L before fees and slippage is ~0 (about +0.03 USDT per trade for Risk Taker and Balanced, 0.00 for Defensive; the net loss per trade is about -0.35 R); the round-trip cost (12 bps fees + about 4 bps slippage + spread) consumes about a third of one stop distance at these stop sizes (net -0.35 R with a gross of ~0). A rule set needs a gross edge larger than that on every trade; these have none.
* Trend-following entries with a 1-ATR stop are worse than random entries with the same exits (trend-always is worse in every case), i.e. the "trend" filter adds nothing in this sample. Balanced and Risk Taker are slightly **below** the random 5th percentile, Defensive is inside the random range.

## 6. Limitations (read before quoting any number)
1. Candle-only-v1 assumes benign microstructure: live results can only be equal or worse.
2. 1m resolution: if both stop and target were touched in one 1m candle the stop is assumed and the trade flagged; this happened 0 times for the analysts (1-3 times for trend-always).
3. Funding history covers about 90 days; 817/640/249 trades (about half) fall outside it and are counted `unknown`, not zero. Known funding totals under 0.3 USDT, so the effect is immaterial, but it is not measured.
4. Day-block bootstrap treats days as independent; the three coins and three analysts on the same bars are correlated, so CIs are narrower than they should be. The sign (all negative) is not in doubt; the width is optimistic.
5. One 180-day regime. The window was also used for the stress calibration (three earlier looks at the 90-day part): no parameter here was tuned on it, but it is not a fresh holdout. The forward ledger is the only true out-of-sample record.
6. Fees assume taker on both legs. Maker entries (limit orders) are not simulated; they would lower cost but add fill uncertainty.
7. Not reproduced here: the legacy scheduled simulator's own 180-day result (a different system: fixed $5 margin, candle-simulated). Nothing in this report depends on it.

## 7. What this means for model training
The question "can a trained model do better" is now answerable under controlled conditions: the rules set a floor of about -0.35 R per trade, break-even before costs, with 16 bps of round-trip cost to clear. Slice 2 pre-registers the target, features, splits, acceptance gate and trial budget (`research-preregistration.md`) before any model is fitted. A rejected model is a valid result.
