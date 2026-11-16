# Roadmap (implementation plan)

The phases follow P2§10. Foundations moved earlier: data quality and timestamps (P2), the append-only ledger (P2,
before any forecast or recommendation), risk scaffolding (P5, before actionable paper setups), and the minimal
replay/paper harness (P5). Acceptance criteria are fixed here **before** results are observed.

## Module boundaries (`server/`)

```
server/
  instruments.js   instrument registry: venue, native id, base/quote/settle, class, linear/inverse, multiplier
  schema.js        canonical event types + validators (ticker, trade, candle, book) -> quarantine on failure
  adapters/bitget.js  REST v2 client (rate limit, backoff+jitter) + WS v2 public supervisor (ping, stale, resubscribe)
  book.js          order-book state: snapshot/update, seq/pseq continuity, crossed/negative/unsorted checks
  store.js         node:sqlite WAL; migrations; idempotent upserts; retention; backup
  health.js        per-feed freshness state machine (HEALTHY/STALE/DISCONNECTED/RECOVERING), clock offset
  ledger.js        append-only decision ledger (DB triggers + SHA-256 hash chain)   [Phase 2b]
  http.js          127.0.0.1 server: serves docs/ + /api/health, /api/instruments, /api/candles, /api/ticker
  main.js          wiring, graceful shutdown, --smoke mode
```
Later phases add `features/`, `hypotheses/`, `policies/`, `risk/`, `paper/`, `forecast/`, `news/`, each consuming
the canonical events, so live and replay share the same code path.

## Phases, gates, status

| Phase | Objective | Gate (fixed in advance) | Status |
|---|---|---|---|
| 0 Discovery | Audit, baseline, isolation | Source/deploy facts documented; user work preserved; local work cannot mutate prod | **VERIFIED** (V-001, V-002); remote Pages settings unknown (release blocker) |
| 1 Requirements | Traceability matrix, architecture, feasibility | Every material requirement has a destination, dependency, verification, status | **VERIFIED** for this revision (`requirements.md`); revisit when scope changes |
| 2 Market data | Bitget BTCUSDT perp end to end, then ETH/XRP, then spot | Real observation → SQLite → API → UI with correct identity and timestamps; fixture tests for duplicate, out-of-order, reconnect, restart, stale and seq-gap pass; live smoke recorded separately | **PARTIAL**: perps exchange→SQLite→API VERIFIED (V-004..006); UI wiring = Phase 3; spot NOT_STARTED |
| 2b Ledger | Append-only decisions before any forecast | UPDATE/DELETE on original rows rejected by the DB; hash chain verifies; outcomes appended separately | **VERIFIED** (V-007); head anchoring pending |
| 3 UI | Honest status strip, TZ selector, fix A-01/A-02 | Values match backend; simulated/stale can't show LIVE; existing workflows still pass (Playwright) | **PARTIAL**: A-01/A-02 fixed + worker strip VERIFIED (V-008); TZ selector, worker-fed charts, accessibility pass pending |
| 4 Features/hypotheses | Specified, tested features; flow hypotheses | Reference fixtures match; causality tests; missing → UNKNOWN | NOT_STARTED |
| 5 Analysts | 3 versioned policies on one evidence snapshot; paper portfolios; minimal replay | Crafted disagreement scenarios; no double-fill; shared limits | NOT_STARTED |
| 6 News/secondary | Fed/SEC feeds, OKX context | Provenance and times visible; revisions don't leak; graceful degrade | NOT_STARTED |
| 7 Forecasts | Baselines, ledgered forecasts, calibration gate | Correct-horizon resolution; no uncalibrated % shown | NOT_STARTED |
| 8 Signals/risk | Full lifecycle, risk engine, kill switch | Rejections consistent; restart-safe; no live execution | NOT_STARTED |
| 9 Backtest/forward | Walk-forward, costs, conservative fills | Reproducible; negative results visible; forward ≠ backtest | NOT_STARTED |
| 10 Adaptation | Drift, challengers, rollback | No promotion without declared evidence | NOT_STARTED |
| 11 Reliability | E2E, faults, backups, measured resources | Critical flows pass; recovery consistent | NOT_STARTED |
| 12 Release | Reviewable release package | READY_FOR_DEPLOYMENT_APPROVAL ≠ DEPLOYED_VERIFIED | NOT_STARTED |

## Phase 2 detailed acceptance criteria (written before implementation)

1. Instrument identity for BTCUSDT perp is derived from the live `contracts` endpoint (not hard-coded), and covers
   venue `bitget`, class `perpetual`, `linear`, settle `USDT`, multiplier = `sizeMultiplier`.
2. Each stored trade has an exchange ts, receipt ts, persist ts, `tradeId`, `schema_version`, `source`.
3. Re-inserting the same trade or candle changes nothing (row count stable; the candle keeps its latest values).
4. Out-of-order candle updates for an older open time never overwrite a newer *final* candle with partial data.
5. A malformed message is quarantined (stored with a reason) and does not crash the worker.
6. Books: a `pseq` mismatch, crossed book, negative size or unsorted levels → book `INVALID` → resubscribe; the book
   becomes valid only after a new snapshot.
7. A feed with no data message for longer than its threshold → `STALE`; a socket closed → `DISCONNECTED`;
   reconnecting → `RECOVERING`; pongs alone never keep a feed `HEALTHY`.
8. Restart: candles/trades persisted before a restart are still there; the worker backfills the candle gap by REST
   and flags rows that came from backfill (`source=rest_backfill`).
9. Retention: trades older than the configured window are deleted by a scheduled job; a test proves it.
10. `/api/health` reports per-feed state, ages, clock offset, DB size, data mode `LIVE`, execution mode
    `ANALYSIS_ONLY`.
11. The live smoke test (from this cloud container) connects to Bitget, persists at least one real trade, ticker and
    candle, and reads them back through the HTTP API. It is reported separately from the CI tests.
