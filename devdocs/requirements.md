# Requirements traceability matrix

Origins: **P1** = first master prompt (WHAT), **P2** = second master prompt (HOW), **C** = documented clarification.
Feasibility: **A** available now · **B** needs a dependency · **C** experimental · **D** not reliably achievable.
Status values: NOT_STARTED · IN_PROGRESS · IMPLEMENTED_UNVERIFIED · VERIFIED · PARTIAL · BLOCKED · DEFERRED ·
NOT_APPLICABLE_WITH_REASON. "Existing" = what was in the repo at `8de2e2a`.
Evidence references point to `verification.md` entries (V-xxx).

## Governance / process (P2)

| ID | Origin | Requirement | Existing | Feas. | Phase | Verification | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| G-01 | P2§3 | Read-only audit, preserve user work, no destructive git | – | A | 0 | git status before/after; no resets | VERIFIED | V-001 |
| G-02 | P2§4 | Baseline build/tests recorded, pre-existing failures distinguished | – | A | 0 | test runs | VERIFIED | V-002 |
| G-03 | P2§5 | Locate "Fable Advisor" | absent | A | 0 | repo search | NOT_APPLICABLE_WITH_REASON (user confirmed: Claude Code dev reviewer, not a site feature) | audit §5 |
| G-04 | P2§7 | Durable records (`devdocs/`) incl. resume.md | – | A | 0 | files exist, updated per commit | IN_PROGRESS | – |
| G-05 | P2§15 | No push/merge/deploy/paid/live trading without approval | – | A | all | `remote actions` log in progress.md | IN_PROGRESS | – |
| G-06 | P2§8 | Small verified milestones, diff review per milestone | – | A | all | progress.md | IN_PROGRESS | – |
| G-07 | P2§14 | Rollback plan per risky change | – | A | all | runbook | IN_PROGRESS | – |
| G-08 | P1§19 | Windows PowerShell startup instructions matching repo | partial (README) | A | 1,12 | instructions reviewed; not executed on Windows (no Windows host); Node 22.13 minimum untested | IMPLEMENTED_UNVERIFIED | V-010 |

## Architecture & data (P1§3–5, P2 phase 2)

| ID | Origin | Requirement | Existing | Feas. | Phase | Verification | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| D-01 | P1§3 | Persistent background worker, explicit module boundaries | none | A | 2 | worker tests + live smoke | VERIFIED (local run; uptime depends on host, B-05) | V-004, V-005 |
| D-02 | P1§3 | Canonical event/feature schema shared by live/replay/backtest | none | A | 2 | schema tests | PARTIAL (market events done; replay/features pending) | V-004 |
| D-03 | P1§4 | Capability registry with live probe results, access dates | partial (SOURCES.md for rules only) | A | 2 | `data-sources.md` | IN_PROGRESS | – |
| D-04 | P1§5 | Observation fields: venue, native id, base/quote/settle, class, linear/inverse, multiplier, exch ts, recv ts, persist ts, seq/trade id, source, schema ver, quality flags | none | A | 2 | schema + tests | VERIFIED (raw-record reference = quarantine copy only for rejected msgs) | V-004, V-005 |
| D-05 | P1§5 | UTC internal; selectable display TZ default Asia/Kolkata | IST hard-coded | A | 3 | UI test | VERIFIED for Asia/Kolkata + UTC (fixed offsets; persisted choice; Playwright V-017). Arbitrary/DST zones not offered |
| D-06 | P1§5 | last/bid/ask/mark/index kept distinct | partly (ticker) | A | 2 | schema | VERIFIED | V-004, V-005 |
| D-07 | P1§5 | REST snapshots + paginated backfill | partial (python) | A | 2 | tests + smoke | PARTIAL (≤1000-candle window backfill; deeper pagination stays in python scripts; unrecoverable gaps logged) | V-004 |
| D-08 | P1§5 | WS heartbeat, supervision, backoff+jitter | partial (browser, no jitter) | A | 2 | fault tests | VERIFIED (worker; browser stream unchanged) | V-004 |
| D-09 | P1§5 | Endpoint rate limits, bounded queues, backpressure | partial (python min interval) | A | 2 | tests | PARTIAL (global REST spacing, not per-endpoint; bounded queue verified) | V-004 |
| D-10 | P1§5 | Idempotent writes, dedupe, out-of-order handling | none | A | 2 | dup/out-of-order tests | VERIFIED | V-004, V-006 |
| D-11 | P1§5 | Clock-offset monitoring | none | A | 2 | test + /api/health | IMPLEMENTED_UNVERIFIED (live value observed; no alert threshold yet) | V-005 |
| D-12 | P1§5 | Gap detection & recovery (REST refill) | gap report only | A | 2 | gap test | PARTIAL: candles refilled and finalised from REST (V-009); trade/ticker/book gaps recorded in `coverage_gaps` with a `coverage()` query (V-010), not refilled | V-004, V-009, V-010 |
| D-13 | P1§5 | Schema validation & quarantine | none | A | 2 | malformed-msg test | VERIFIED | V-004 |
| D-14 | P1§5 | Graceful shutdown, restart recovery | none | A | 2 | restart test | VERIFIED: real SIGINT live (V-010); crash detection + downtime gap in fixtures; a real kill -9 of the process is not tested | V-004, V-006, V-010 |
| D-15 | P1§5 | Order book snapshot/delta, seq checks, crossed/negative detection, invalidate→resync | none | A | 2 | seq-gap fixtures | VERIFIED (continuity rule observed, not documented: D-007) | V-004, V-005 |
| D-16 | P1§5 | Missing ≠ zero, unknown ≠ neutral; gap flags propagate | violated (A-03) | A | 2,4 | tests | IN_PROGRESS | – |
| D-17 | P1§5 | Data mode LIVE/DELAYED/REPLAY/SIMULATED; health HEALTHY/STALE/DISCONNECTED/RECOVERING; exec ANALYSIS_ONLY/PAPER | none | A | 2,3 | health tests + UI | PARTIAL (worker API + browser LIVE/STALE/RECOVERING/DISCONNECTED verified; REPLAY/SIMULATED modes not built yet) | V-004, V-008 |
| D-18 | P1§5 | Feed-specific stale thresholds, tested | none | A | 2 | stale tests | PARTIAL (tested logic; values need long-run cadence data, B-05) | V-004, V-005 |
| D-19 | P1§5 | Alternate venue never silently replaces Bitget quote | n/a | A | 6 | test | NOT_STARTED | – |
| D-20 | P1§3 | Bounded retention, disk budget, compaction | none | A | 2 | retention test | PARTIAL (retention verified; disk budget not measured over a day) | V-004 |
| D-21 | P1§4 | BTC, ETH, XRP perps + spot as distinct instrument class | perps only | A | 2 | instrument tests | PARTIAL (3 perps VERIFIED live; spot NOT_STARTED) | V-005 |
| D-22 | P1§4 | One secondary venue (labelled context) | none | A (OKX reachable? untested) | 6 | probe | NOT_STARTED | – |
| D-23 | P1§4 | CCXT evaluation | none | A | 6 | – | DEFERRED (direct API sufficient for one venue; D-002) | – |

## Features & inference (P1§6–8)

| ID | Origin | Requirement | Existing | Feas. | Phase | Verification | Status |
|---|---|---|---|---|---|---|---|
| F-01 | P1§6 | Returns, realized vol, ATR, vol percentiles | ATR (engine) | A | 4 | fixtures | NOT_STARTED |
| F-02 | P1§6 | Spread & depth within bps bands | none | A | 4 | fixtures | NOT_STARTED |
| F-03 | P1§6 | Volume anomaly vs trailing baseline | partial | A | 4 | fixtures | NOT_STARTED |
| F-04 | P1§6 | Trade-size percentiles, aggressive buy/sell, CVD w/ reset rules | none | A (semantics unverified, D-008) | 4 | fixtures | NOT_STARTED |
| F-05 | P1§6 | Book imbalance in depth bands | none | A | 4 | fixtures | NOT_STARTED |
| F-06 | P1§6 | OI change (units), funding level/changes w/ settlement schedule | snapshot only | A | 4 | fixtures | NOT_STARTED |
| F-07 | P1§6 | Spot/perp premium | none | A (needs spot feed) | 4 | fixtures | NOT_STARTED |
| F-08 | P1§6 | VWAP + causal anchored VWAP | session VWAP | A | 4 | fixtures | PARTIAL |
| F-09 | P1§6 | Rolling correlations, divergences | none | A | 4 | fixtures | NOT_STARTED |
| F-10 | P1§6 | Regimes (trend/range/vol) | 1h EMA trend | A | 4 | fixtures | PARTIAL |
| F-11 | P1§6 | Rule-defined breakouts/failed breakouts/sweeps; pivots available only after confirming bars | breakouts/fails exist, causal | A | 4 | causality tests | PARTIAL |
| F-12 | P1§6 | Per-feature spec (formula, units, warm-up, availability ts, version, tests) | none | A | 4 | spec doc + tests | NOT_STARTED |
| F-13 | P1§6 | Decimal/integer precision for money & rounding | float | A | 8 | tests | NOT_STARTED |
| H-01 | P1§7 | Flow hypothesis engine with support/contradict/alternatives/coverage/invalidation/expiry/status | none | C | 4 | crafted scenarios | NOT_STARTED |
| H-02 | P1§7 | Observed vs estimated liquidation schemas separate; no heatmap w/o inputs | none | B | 4 | – | NOT_STARTED |
| H-03 | P1§8 | ETF/COT/macro/on-chain with publication lag & vintages | none | B/C | 6 | – | NOT_STARTED |
| H-04 | P1§7 | Never claim named-institution activity | n/a | D (claim) → A (rule) | 4 | review | NOT_STARTED |

## Analysts, signals, risk, paper (P1§9–11, 13–14)

| ID | Origin | Requirement | Existing | Feas. | Phase | Verification | Status |
|---|---|---|---|---|---|---|---|
| S-01 | P1§9 | Three policies on one versioned evidence snapshot, explicit rule specs | 3 profiles, not shared snapshot | A | 5 | disagreement scenarios | VERIFIED (fixtures): evidence-v1 + risk_taker/balanced/defensive-v1; pre-registered S1–S7 pass (V-012). Live forward decisions: pending elapsed time |
| S-02 | P1§9 | Separate virtual portfolios, 1,000 USDT each, identical windows | journal $5/trade | A | 5 | tests | IMPLEMENTED (forward paper, persisted; V-012). Historical replay over identical windows: NOT_STARTED |
| S-03 | P1§10 | Economic intents OPEN/REDUCE/CLOSE/WAIT/NO_TRADE; no exit w/o position | BUY/SELL only | A | 8 | tests | PARTIAL: OPEN_LONG/OPEN_SHORT/WAIT/NO_TRADE with reason codes; exits are engine-managed (stop/target/time), REDUCE not implemented; no exit intent without a position (tested) |
| S-04 | P1§10 | Setup/order/position state machines, transitions w/ reason codes, no duplicate triggers, versioned supersession | none | A | 8 | tests | PARTIAL: decision → RISK_APPROVED/REJECTED → POSITION_OPENED → POSITION_CLOSED → outcome as ledger rows; duplicate trigger prevented (tested). Paper orders are immediate market fills (no separate order book/partial fills); setup supersession not yet modelled |
| R-01 | P1§11 | Independent risk engine: per-trade, open risk, exposure, correlation, daily loss, drawdown, leverage ≤2×, liquidity, staleness, kill switch, persisted state | lab sizing only | A | 5→8 | tests | PARTIAL: all listed checks VERIFIED on fixtures incl. size ≤ 10% of visible depth within 10 bps (V-012, V-015); event-risk restrictions NOT implemented; maintenance tiers beyond tier 1 not modelled; open/close writes not atomic across position+portfolio+ledger |
| R-02 | P1§11 | NO_TRADE when min size breaches budget | lab has min-size | A | 8 | test | VERIFIED (S8; 864 cross-language sizing cases) |
| L-01 | P1§13 | Append-only prediction/decision ledger (DB triggers + hash chain), backups | none (journal rewritten) | A | 2 | tamper tests | VERIFIED for storage rules (V-007); nothing writes forecasts to it yet; off-machine head anchoring pending |
| B-01 | P1§14 | Event-driven replay reusing live code; purged chronological splits; locked test | lab has dev/holdout for 4H | A | 2→9 | determinism tests | PARTIAL: `server/replay.js --verify` re-derives recorded forward decisions exactly (V-015). Historical (assumption-based) replay/backtest of the v1 policies with purged splits: NOT_STARTED |
| B-02 | P1§14 | Execution sim: spread, fees, slippage, latency, funding at settlement, ambiguous bars conservative | lab partial | A | 9 | tests | PARTIAL: forward paper uses ask/bid + 2 bps, taker fees, funding at settlement, trade-tape ordering (no candle ambiguity), gap → unevaluable (V-012). Latency, partial fills, order rejection beyond min-size: not modelled |
| B-03 | P1§14 | Metrics incl. block bootstrap, baselines, "no demonstrated edge" status | lab partial | A | 9 | tests | PARTIAL (lab) |

## Forecasts, news, UI, adaptation, security (P1§12, 15–18)

| ID | Origin | Requirement | Existing | Feas. | Phase | Verification | Status |
|---|---|---|---|---|---|---|---|
| P-01 | P1§12 | Forecast objects separate from setups; explicit targets/horizons | logistic model, mislabelled (A-02) | A | 7 | – | NOT_STARTED |
| P-02 | P1§12 | No probability shown until calibration gate passes | violated | A | 3 (relabel), 7 | UI test | PARTIAL: model card relabelled as uncalibrated score (V-008); calibration gate = Phase 7 |
| P-03 | P1§12 | Baselines: random walk, rolling dist., momentum | none | A | 7 | – | NOT_STARTED |
| P-04 | P1§12 | Unevaluable outcomes marked, not counted | none | A | 7 | test | NOT_STARTED |
| N-01 | P1§15 | Official news sources w/ publication/discovery/revision, dedupe, untrusted handling | none | A (Fed/SEC hosts allowed) | 6 | tests | PARTIAL: Fed + SEC press RSS VERIFIED live and in fixtures (V-014); other official sources (CFTC, FRED vintages, exchange status, issuers) NOT_STARTED |
| N-02 | P1§15 | Optional LLM: disabled by default, schema-validated, no authority | none | B | 6 | – | DEFERRED |
| U-01 | P1§16 | Instrument selector, venue/class labels, feed age, mode labels | partial | A | 3 | Playwright | PARTIAL: feed age + honest mode + worker feed states verified (V-008); spot selector pending |
| U-02 | P1§16 | Analyst cards w/ NO_TRADE reasons, hypotheses, news, portfolio/risk | partial | A | 3/5 | Playwright | PARTIAL: v1 analysts card (decision, reason code, setup, paper portfolio, no-edge status) VERIFIED in worker mode (V-013); hypotheses/news NOT_STARTED |
| U-03 | P1§16 | Verification workspace (forecast vs outcome, backtest vs forward separate) | partial (journal card) | A | 9 | Playwright | NOT_STARTED |
| U-04 | P1§16 | Multiple tabs must not create duplicate upstream collectors | each tab opens own WS | A | 3 | worker serves tabs | VERIFIED in worker mode: tabs poll /api and open 0 Bitget sockets (V-011). On GitHub Pages (no worker) each tab still streams for itself; nothing is persisted |
| U-05 | P1§16 | Accessible contrast, keyboard nav, text labels with colors | partial | A | 3 | audit | NOT_STARTED |
| U-06 | P1§16 | In-app alerts w/ dedupe/cooldown | none | A | 8 | tests | NOT_STARTED |
| X-01 | P1§17 | Drift/calibration monitoring, champion/challenger, predeclared promotion, rollback | lab dev/lock/holdout | A/C | 10 | tests | NOT_STARTED |
| Y-01 | P1§18 | No secrets in bundles/logs; placeholders only; sanitized errors | OK today (no secrets) | A | all | secret-scan test | IN_PROGRESS |
| Y-02 | P1§18 | Live order placement absent/hard-disabled | lab `live_allowed=False` | A | all | test | VERIFIED (lab) / worker: no order code |
| Y-03 | P1§18 | Local API: bind 127.0.0.1, input validation, request limits | none | A | 2 | tests | VERIFIED (V-004) |
| Y-04 | P1§18 | Backups/restore, heartbeat/readiness, disk monitoring | none | A | 2/11 | tests | PARTIAL (backup+integrity verified; restore drill, scheduled backups pending) |
| Z-01 | P1§20 | Phase 9 end-to-end flow | none | A | 11 | e2e test | NOT_STARTED |
| Z-02 | P1§22 | Report whether an edge is demonstrated | lab criteria exist | A | 9 | – | IMPLEMENTED: every portfolio reports NO_DEMONSTRATED_EDGE; no edge has been demonstrated |

## Not reliably achievable (D) — replaced with testable alternatives

| Claim | Replacement |
|---|---|
| Guaranteed profit / perfect prediction | Calibrated, out-of-sample-evaluated forecasts with "no demonstrated edge" as a valid state |
| Seeing institutional positions | Evidence-linked flow *hypotheses* with competing explanations (H-01) |
| Continuous operation from a static site / sleeping laptop | Local worker with documented uptime limits; gaps recorded, not filled |
