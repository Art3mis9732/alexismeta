# Pre-registration: can a trained model beat the cost hurdle? (research-prereg-v1)

**Committed before any model is fitted.** Nothing below may be changed after the first fit; a change is a new version (`research-prereg-v2`) with a fresh final segment. Written 2026-11-17 after `hist-evaluation-report.md` (Slice 1). Nothing here trades, changes a policy or touches the forward worker.

## 0. Why this exists, and what we expect
Slice 1 showed the three rule analysts are break-even before costs and about **-0.35 R per trade** after costs, indistinguishable from random entries with the same exits. The existing display-only logistic regression predicts next-bar direction at ~52% accuracy and loses after costs. So **accuracy is not the goal and not the gate**; an after-cost trade outcome is. Prior expectation: the most likely outcome is **REJECTED** (no model clears the cost hurdle). A rejection is a complete and useful result and is shown in the UI like any other.

## 1. The single target
For every coin, every closed 15-minute decision bar `t` and each side `s` in {LONG, SHORT} a **template trade** is labelled with the live cost and exit rules:
* entry at the bar close reference (ask for long, bid for short) times (1 + s x 2 bps); stop 1.0 x ATR(14, 15m) away; target 1.5 x ATR; time exit 32 bars (8 h) at the next 1m open; taker fee 6 bps and slippage 2 bps on each leg; spread one tick (candle-only-v1 assumption, an upper bound); funding ignored (only 90 days of history exist and an 8 h hold is dominated by costs; documented, not hidden).
* Exit order inside a bar is resolved on **1-minute candles** with `research/simulate.js exitOnCandle` (stop wins a tie; a gap fills at the open).
* **Label** `y = 1` if the trade's net result after all costs is > 0, else 0. The realised **net R** (net divided by the 1.0 ATR risk, costs included) is stored for evaluation. One model, rows = (coin, bar, side), side-oriented features. The template is the Balanced analyst's reward-to-risk and time exit; it is fixed here and is not tuned.

## 2. Features (candle-derived only, computed by the same JavaScript code as live, point-in-time)
From the evidence snapshot at bar `t`: `trend_1h`, `above_vwap`, `(close - vwap) / ATR`, `atr_pct`, `atr_pctile`, `change_24h`, `rv_24h`, counts and signs of active triggers (BO/RETEST/VWAP/FAIL families) ; plus returns over 1, 4, 16 and 96 bars divided by ATR; position of the close inside the 96-bar range; volume relative to its 96-bar mean; hour of day (sine/cosine). Directional features are multiplied by the side (+1 long, -1 short). **No coin identifier, no calendar date, no microstructure, no news, no funding.** The list is final; adding a feature is a new version.

## 3. Data and splits (time only, fixed by rule before any fit)
* Data: public Bitget candles for BTC/ETH/XRP USDT perpetuals, 15m and 1m, as far back as the endpoints serve contiguous data (about 2 years: 2024-11-17 onwards; verified 15m, 1m verified at build time). Gaps are reported, never filled; a bar with a gap in its label window is dropped.
* Burn-in: first 14 days dropped. Usable span split **in time order** into TRAIN 55%, VALIDATION 20%, FINAL 25%, with a **3-day embargo** (more than the 8 h label horizon) removed at each boundary, and any row whose label window (t, t + 8 h] crosses a boundary dropped (purge). All three coins use the same timestamps (no coin is in train while another is in validation at the same time).
* The builder writes `split.json` (exact timestamps) and the dataset manifest (sha256 of every input file and of the feature matrix) **before any model is fitted**; that file is committed first.
* **FINAL is scored exactly once**, for the one configuration chosen on VALIDATION (or for "none selected"). It is not used for model choice, threshold choice or feature choice. It is not blind to the author (the same period was replayed in Slice 1 with frozen rules), which is why the forward shadow period, not FINAL, is the true holdout.
* Effective sample: about 3 coins x 2 sides x 35k bars is ~200k rows, but coins are strongly correlated, sides are mirror images, and neighbouring labels overlap (8 h windows), so the effective number of independent observations is a few thousand at most. Hence shallow models and day-block confidence intervals.

## 4. Models and trial budget
M0 constant base rate. M1 the existing feature family re-fit under this split ("legacy LR"). M2 L2 logistic regression (regularisation grid, standardisation fit on TRAIN only). M3 histogram gradient boosting, shallow (max depth <= 3, <= 200 iterations, learning rate 0.05, min leaf >= 500). **Total fitted configurations including the decision threshold grid {0.50,0.52,...,0.70} are capped at 40.** Every trial, including failed and rejected ones, is appended to the trial log (`research/registry/trials.jsonl`: id, family, parameters, data hash, split, metrics, timestamp); the count is reported next to any result. scikit-learn is pinned (`requirements.txt`) and its version recorded per run. Models are exported as JSON (coefficients or tree arrays) with a JS-vs-Python scoring parity test; no pickle is committed. Only a model with a verified JSON exporter can enter forward shadow evaluation.

## 5. Evaluation and acceptance gate (all must hold on FINAL; otherwise REJECTED)
Selection rule on FINAL: for each coin and bar take the side with the higher probability if it is >= the validation-chosen threshold; one position per coin at a time; **fixed 1R risk per trade, no compounding, no portfolio coupling** (so results are comparable and not dominated by account path).
1. **At least 300 trades** on FINAL (fewer: INSUFFICIENT_SAMPLE, not a pass).
2. Mean **net R per trade** after costs, **day-block bootstrap 95% CI lower bound > 0**.
3. Mean R per trade above the **95th percentile of 200 random-entry runs with the same trade count, same coin mix and same template exits**.
4. Positive mean R in at least 2 of the 3 coins and in both halves of FINAL.
5. Still positive with costs raised by 25% (reported as a stress check; it must be > 0 to pass).
Reported beside it, not gating: log loss and Brier score against the base rate, calibration, the Slice 1 analysts' own trigger entries scored with the same template and the same segment, trades per day, and results by coin, side and volatility regime. A model that passes is **a candidate for forward SHADOW evaluation only**; it is never promoted automatically, never places or changes a paper trade, and promotion needs a separate explicit user decision after a forward shadow period.

## 6. Leakage and integrity checks (tested, mutation-verified)
* Perturbing candles **after** bar `i` leaves every feature of row `i` unchanged and changes its label.
* Label-shuffled control: a model trained on shuffled TRAIN labels must show no skill on VALIDATION (its log loss is not better than the base rate beyond noise).
* No row's label window crosses a split boundary; scaler and imputation are fit on TRAIN only; the manifest hash is re-checked before FINAL is scored.
* Python and JavaScript features agree to 1e-9 on a fixed sample.

## 7. Non-goals
No live or exchange trading, no private endpoints, no real money, no change to policies, risk limits or the forward ledger, no automatic promotion, no paid services, no new network hosts. Research artifacts live in files (gitignored data, committed small manifests and registries); no forward-database writes and no schema change.
