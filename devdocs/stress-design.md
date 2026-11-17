# Market-stress detector: design, data contracts and policy (stress-v1 / stress-policy-v1)

Code: `server/stress.js` (pure), `server/stress_monitor.js` (runtime), `server/stress_fixture.js` (TEST-only synthetic scenario), UI `docs/stress.js`.
Evidence: `stress-calibration.md`, `evidence/stress-calibration-2026-11-17.json`. **Status: PROVISIONAL, policy in SHADOW.**

## 1. What it is
A deterministic monitor of abnormal conditions for BTC, ETH and XRP USDT perpetuals. It keeps **severity** (NORMAL, ELEVATED, HIGH_STRESS, CRITICAL: what the market is doing)
separate from **data quality** (VALID, DEGRADED, UNRELIABLE: whether we can see it). Not machine learning: nothing is trained; thresholds are fixed numbers from development-period quantiles.
It reacts to moves that have happened; it does not predict them (see the calibration doc).

## 2. Data contracts
| Signal | Source | Unit / cadence | Timestamp used | Freshness required | History available | Missing / reconnect behaviour | Used for |
|---|---|---|---|---|---|---|---|
| Price | Bitget WS ticker `last` | USDT, sampled every 5 s by the monitor; after a restart seeded from final 1m candle closes | local receive time (exchange time is stored too) | ticker < 10 s old (same threshold as the feed-health STALE rule) | in-memory 20 min | ticker older than 10 s => data quality UNRELIABLE; no price => no move metric | severity (P) |
| 1m candles | store, `final=1`, REST-backfilled (1000 rows) at start and reconnect | base-coin volume, close | candle open time | latest final candle < 3 min old for V and A | 90 days retained, **with holes after downtime (180 of 2516 minutes in the first day's data)** | a return or rolling window exists only if every minute in it exists; gaps are counted, never bridged; baseline needs >= 600 contiguous returns | severity (V, A), baseline |
| Spread | ticker bid/ask | bps, median of last 30 s | local receive | ticker fresh | the monitor's own per-minute samples (`stress_samples`), none before v9 | needs >= 360 samples (6 h); until then unavailable (reported, not "normal") | severity (S), **provisional** |
| Visible depth | full in-memory book | USDT within +/-10 bps of mid, each side; min side | local receive | book state VALID | **none**: the stored top-20 reaches only 0.6-0.8 bps (BTC) and 1.4-1.6 bps (ETH) so no historical depth exists | invalid/resyncing book => depth unavailable and quality UNRELIABLE | severity (D), **provisional** |
| Open interest | ticker `holdingAmount` | base coin | local receive | - | stored in tickers (7 d) | missing => quality DEGRADED | **context only** |
| Funding rate | ticker `fundingRate` | fraction per interval; **interval is not stated by the feed** | local receive | - | stored in tickers | - | **context only** |
| Book imbalance | full book | (bid-ask)/(bid+ask) depth, +/-10 bps | local receive | - | none | - | **context only** (spoofable) |
| Trade side | WS trades | aggressor semantics unverified (D-008) | - | - | - | - | **not used**: no tape-imbalance signal exists |
Not implemented because the data does not exist here: liquidation flows, holder/institution positioning, cross-venue prices, historical depth. Cross-asset co-movement widens SCOPE (see policy), never raises severity.

## 3. Measurements and rules
* **P** = max over 1, 5, 15 min of |log move| / (sigma1m * sqrt(minutes)); sigma1m = 1.4826 * MAD of 1m log returns over the trailing 24 h (floor 2e-5, zero-scale safe).
* **V** = realised volatility of the last 15 one-minute returns / median of the same measure over the baseline (floor 1e-4).
* **A** = robust z of log(5-minute volume) over the baseline (confirms price only).
* **S** = spread now / max(median spread, 0.5 bps). **D** = min-side depth now / median min-side depth (lower is worse).
* **Baseline** ends `excludeMs` = 15 min before now, so the scored window is excluded and no future data is used; **while an event is active it is frozen at the event onset**, so a continuing crash cannot normalise itself.
* **Families (not independent confirmations):** price = max(level(P), level(V)); activity = level(A); liquidity = max(level(S), level(D)).
  ELEVATED: price >= 1 or liquidity >= 1. HIGH: price >= 2, liquidity >= 2, or (price >= 1 and activity >= 2). CRITICAL: price >= 3, or (price >= 2 and liquidity >= 2). Liquidity alone caps at HIGH.
  No available family => severity unknown (null), never NORMAL.
* **Data quality:** UNRELIABLE if the ticker is older than 10 s or never arrived, any of ticker/books/trade feeds is not HEALTHY, the book is not VALID, there is a coverage gap in the last minute (same rule the risk gate uses), or the price family is unavailable (e.g. baseline not ready). DEGRADED if only liquidity warm-up, a stale 1m candle, or missing open interest. Otherwise VALID.
* **State machine:** escalation needs 30 s persistence at the lowest raw level seen while pending; the event onset is the first threshold crossing. Recovery needs a dwell at the current level (ELEVATED 10 min, HIGH 15, CRITICAL 20) and steps down to the highest raw level seen meanwhile. UNRELIABLE or unknown input freezes everything: severity and last-valid time are retained, nothing escalates or recovers.
* **Events** open when severity leaves NORMAL (id `stress:<instrument>:<onset minute>`) and close as RECOVERED at NORMAL. A monitor that was not running for more than 5 min closes the event as **UNOBSERVED** (we do not know whether it ended), keeps the last valid severity and its time for display, and starts fresh.
* **Trend** (WORSENING / IMPROVING / STEADY) is defined only as raw level above / below / equal to the confirmed level, and is UNKNOWN when data is unreliable.
* **Maximum confirmation delay:** 60 s from the first threshold exceedance (persistence 30 s + 5 s cadence). This is not the delay from the start of a move (calibration doc).

## 4. Risk policy (stress-policy-v1): the explicit table
Stress can only **block NEW paper entries**. It never closes, reduces, re-prices or resizes an open position, never touches accounting, stops, targets, time exits or funding, and is never consulted by `manage()`.
| State | Scope | New entries | Exposure | Open positions | Recovery |
|---|---|---|---|---|---|
| NORMAL | - | no change | no change | as always | - |
| ELEVATED | asset | allowed, warning only | no change | as always | dwell 10 min |
| HIGH_STRESS | the asset; **all assets when two or more are HIGH or worse** | blocked | no change (no reduction rule in v1) | as always | dwell 15 min |
| CRITICAL | all assets (BTC/ETH/XRP are one correlated bucket) | blocked | no change | as always | dwell 20 min |
| DATA UNRELIABLE | asset | blocked | no change | retained with last-valid timestamps; no fabricated exit | usable again; after an outage of >= 5 min (incl. a monitor that was not running) usable for a further 5 min |
| UNKNOWN (no state, monitor silent > 30 s, warm-up) | asset | blocked (when enforced) | no change | as always | monitor evaluating again |
Not implemented: exposure reduction, forced exits, size scaling, extra confirmation requirements. No crash-triggered training or model replacement (ever).
* **Where it is evaluated:** inside `risk.evaluate`, i.e. at the final authorisation point, from the monitor's state at that instant (one fresh read per authorisation). A signal generated earlier cannot bypass a newer restriction (tested). `evidence-v1` snapshots and replay are unchanged; with no `stress` argument `risk.evaluate` behaves exactly as before (the 864 sizing fixtures still pass).
* **Mode:** `SHADOW` (default, every environment): the verdict is recorded in the ledger risk status (`payload.stress`, `versions.stress`) but nothing is blocked. `ENFORCE` (`--stress-mode enforce`) blocks. **Enforcing is a forward strategy change**: it needs the user's explicit approval and a recorded effective time (the mode and its start time are in `/api/stress` and `/api/runtime`). Before enforcing, read the SHADOW record: how often it would have blocked, and what those entries did.
* Consequence to know before enforcing: Bitget websocket drops were observed about every 10-13 minutes (09:38, 09:51, 10:01 UTC on 2026-11-17); each one is a coverage gap that already makes the existing gate say COVERAGE_GAP for about a minute.

## 5. Persistence (schema v9, additive)
* `stress_transitions`: append-only (triggers), every state/quality/event change with measurements, thresholds version, policy version, mode, calibration status, origin (LIVE | SYNTHETIC_FIXTURE). Forever.
* `stress_state`: current state per instrument (mutable, operational), written on change and at least every 60 s; restored at start.
* `stress_samples`: one row per instrument per minute (spread, depth, OI, funding, imbalance, last): about 4,300 rows/day, 30 days retained (about 130k rows, a few MB). Always real measurements.
* A FORWARD database refuses SYNTHETIC_FIXTURE rows at the database level; the monitor refuses a synthetic scenario outside TEST. TEST runs use `--stress-fixture` (compressed timing, scripted BTC crash with an outage; ETH/XRP real).
* Migration v9 validated on a copy of the real forward database (V-031) before any live use.

## 6. API and UI
`GET /api/stress` (read-only): per instrument severity, quality, last valid, event, trend, measurements with levels, thresholds, baseline, gate verdict, news context (relevance applied before the limit; publication time used when stated); event history; policy table; config incl. mode and calibration.
UI: a summary strip on every tab and a **Market stress** tab; observed measurements, possible explanation (news that coincides in time; interpretation is rule-based and unevaluated) and unverified hypotheses (none asserted) are kept apart. The static page says a worker is needed and shows nothing simulated.
