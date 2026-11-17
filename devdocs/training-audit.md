# What is actually trained? (audit, 2026-11-17, session 5)

Method: source inspection of `scripts/`, `server/`, `bgbot/`, `.github/workflows/`, plus the published `docs/data/model.json`
(snapshot in this checkout, generated 2026-11-15 08:28 UTC). Nothing here is a claim about the live GitHub Pages site, which I
have not opened. "Exists / runs" is source-confirmed; "runs" for the scheduled job means it is scheduled in a workflow, not that I
observed a run.

**Short answer.** One genuinely fitted model exists: a **logistic regression per timeframe (5m, 15m, 4H)** trained by
`scripts/train_model.js` and retrained daily by a GitHub Actions workflow. It is display-only (no decision path reads it), and on
its own held-out data it shows **no edge** (below). Nothing else is trained. The three paper analysts are deterministic rules.
There is no genetic algorithm, no reinforcement learning, no gradient boosting, no model registry, no job runner, and no
promotion/rollback machinery. An earlier session summary and the pasted external analysis said "no trained model"; that was wrong
for this one component and is corrected here.

| Component | Exists | Runs | Model training? | Data | Results stored | Improves automatically | Effectiveness verified | Missing |
|---|---|---|---|---|---|---|---|---|
| Continuous live data collection (`server/collector.js`) | yes | yes (worker) | no | Bitget public WS/REST | SQLite, retention-bounded | no (a larger dataset is not learning) | feed health verified (V-022) | nothing for training |
| Three analysts: Risk Taker / Balanced / Defensive v1 (`server/policies.js`) | yes | yes at each 15m bar close | **no**: fixed rule sets, versioned | evidence-v1 snapshot | append-only ledger | no | replay reproduces recorded decisions (45/0 mismatches); **no edge demonstrated**, 5 natural positions all closed by stop (uncertain, V-027) | exact historical backtest of the v1 rules |
| News classification (`server/news.js`, `news_interpret.js`) | yes | yes | **no**: keyword/regex rules, `news-rules-v1.1` | official feeds | interpretations + runs, append-only | no | rule behaviour unit-tested on real fixtures; **accuracy never measured against outcomes** | evaluation by ablation; Fed-speech rule overreach (defect 12) |
| LLM news sentiment | **no** (interpreter `llm-grounded` registered but disabled) | no | n/a | n/a | n/a | n/a | n/a | everything |
| Observed price reaction (`server/news_reaction.js`) | yes | yes | no: arithmetic on 1m candles | candles after discovery | computed on read | no | unit-tested; all current items are backlog so every window is N/A | live items to accumulate |
| Legacy pattern statistics (`scripts/pattern_stats.js`) | yes | scheduled daily | no: counting/averaging historical outcomes | 180d of 15m (and 5m, 4H) candles | `docs/data/stats.json` | recomputed daily, not learned | reports adverse after-fee results for the legacy profiles | exact v1 analyst backtest |
| **Logistic regression (`scripts/train_model.js`)** | **yes** | **scheduled daily** (`stats.yml`, 01:41 UTC), also by hand | **yes** | features from `docs/patterns.js` (indicators, VWAP, trend, recent moves, time of day), all three coins pooled | `docs/data/model.json` (weights, test metrics) | **retrained from scratch daily with no acceptance gate**; display-only, so a bad refit changes only the page | held-out numbers below: **no edge** | calibration, purged walk-forward, versioning, registry, forward shadow test |
| Historical backtesting (Python lab `bgbot/`, `bgbot/experiment.py`) | yes | by hand | **no model fit**: strategy parameters run with a development/lock/one-shot-holdout protocol | candles | `results/` | no | 22 pytest pass; adverse legacy result reported | reproduction of the 180-day result under cost assumptions; v1 analysts not ported |
| Automatic retraining | partial: the daily refit above | yes (scheduled) | yes | as above | overwrites `model.json` each day | refit on more data, not "improvement" | no | drift trigger, gate, rollback |
| Genetic / evolutionary optimisation | **no** (no code) | no | no | no | no | no | no | everything |
| Reinforcement learning | **no** (no code) | no | no | no | no | no | no | simulator, reward, evaluation |
| Gradient boosting, XGBoost, LightGBM, sequence models | **no** (no code or dependency) | no | no | no | no | no | no | everything |
| Model registry / training jobs / promotion / rollback | **no** | no | no | no | no | no | no | only the analyst registry (`policies.js`) exists and it labels analysts "DETERMINISTIC, training NOT APPLICABLE" |
| Forward paper trading | yes | yes | no | live evidence | ledger, fills, funding | no | accounting reconciled; **no edge** | more natural observations |

## The one trained model, in numbers (from `docs/data/model.json`, snapshot 2026-11-15)
Method as coded: standardise, L2-regularised logistic regression by Adam (400 iterations), train on the first 70% of the timeline,
test once on the last 30%, then refit on everything for the live display. Label: price higher 16 candles ahead.
| TF | test rows | accuracy | best coin-flip rule | log loss vs no-model | trades under its own rule (long >60%, short <40%, 16 candles, 14 bps) | mean net / trade | win rate |
|---|---|---|---|---|---|---|---|
| 5m | 46,608 | 52.5% | 51.3% | 0.692 vs 0.693 | 938 | −18.1 bps | 39.3% |
| 15m | 15,504 | 51.7% | 52.0% | 0.696 vs 0.693 | 975 | −29.6 bps | 37.9% |
| 4H | 5,865 | 49.8% | 54.6% | 0.712 vs 0.696 | 385 | −181.0 bps | 41.8% |

Reading: at 15m and 4H the model is no better than predicting the base rate (log loss worse than "no model" at 15m and 4H, accuracy
below the coin-flip rule). At 5m it is marginally better in log loss, with a negative after-cost result. Labels overlap (each
bar looks 16 bars ahead), so the effective number of independent test cases is far smaller than the row counts, and one 70/30
split gives no uncertainty estimate. The site labels these scores "uncalibrated, not probabilities", which is correct. I did not
re-run the training here; these are the published numbers.

## What genuine training infrastructure would still need (order of work, unchanged)
1. Trustworthy point-in-time historical evaluation of the existing analysts (milestone D); without it nothing trained can be judged.
2. Immutable dataset manifests (hash, period, features, label definition) and purged chronological walk-forward folds.
3. A baseline fit (regularised logistic regression is already one) with calibration, a no-trade and a deterministic baseline, costs.
4. A model registry and bounded job runner outside the ingestion process, with real state (queued/running/succeeded/failed).
5. Forward shadow evaluation of a candidate, with promotion only by explicit approval, and rollback that never rewrites the ledger.
6. Only then: evaluate GA (parameter search), ensembles, sequence models, RL. Each needs a trial budget and an untouched final period.
