# Verification log (validation report)

Each entry records: revision · command/procedure · when (UTC) · expected · observed · limitations.
"Cloud container" = this ephemeral Linux session; it does not verify the Windows runtime.

## V-001 Initial repository state (Phase 0)
* Revision `8de2e2a` (branch `claude/friendly-dirac-ouvgn4` = `origin/main`). 2026-11-16 ~07:40.
* `git status`: clean, nothing staged, no untracked files. Remote `gh-pages` = `7db64c3` ("publish 2026-11-16T06:51Z").
* Observed: no user changes to preserve. Forward journal copied read-only from `gh-pages` to
  `devdocs/evidence/gh-pages-journal-2026-11-16.json` (109 trades since 2026-11-11 12:53 UTC; legacy profiles).

## V-002 Baseline tests (Phase 0)
* `node --test tests_js/patterns.test.js` → 23 pass, 0 fail (Node 22.23.4).
* `.venv/bin/python -m pytest -q` → 22 passed (Python 3.13.18, pandas 3.1.1, numpy 2.5.5, pytest 9.2.0).
  CI uses Python 3.11; versions differ, results agree.
* Limitations: no CI run was triggered (nothing was pushed).

## V-003 Bitget reachability (cloud container)
* Default environment: CONNECT 403 for `api.bitget.com` (proxy policy).
* After the user approved the `alexismeta` environment (hosts listed in `data-sources.md`):
  `GET /api/v2/public/time` → 200 `00000`; Node `fetch` with `NODE_USE_ENV_PROXY=1` OK; Node built-in `WebSocket`
  to `wss://ws.bitget.com/v2/ws/public` → `ticker`, `trade`, `candle1m`, `books`, `books15` subscriptions
  acknowledged, and snapshot and update messages received (2026-11-16 ~07:46 UTC).

## V-004 Worker fixture tests (Phase 2) — deterministic, no network
* Revision: Phase 2 slice commit (see git log). `npm test`, i.e. `node --test "tests_js/*.test.js"`: **47 pass, 0 fail**
  (23 legacy engine + 24 worker).
* Fixtures `tests_js/fixtures/bitget/*.json` are real Bitget payloads captured 2026-11-16 07:51 UTC (contracts subset,
  REST 1m candles, WS ticker, trade, candle1m and books, with books trimmed to 10 levels and the seq chain kept intact).
* Covered: instrument identity and wrong-class guard; exact decimal strings; missing funding/OI become NULL plus a
  flag; malformed trades, candles and books rejected; REST finality from `requestTime`; book chain valid, seq gap,
  duplicate/late, crossed, negative, unsorted, size-0 delete; duplicate trades idempotent; out-of-order candles
  (partial never overwrites final, older never overwrites newer, identical final is a no-op, a correction applies);
  restart persistence plus WAL plus idempotent migration; retention; bounded queue; backup integrity; health
  (pongs ≠ data, STALE/DISCONNECTED/RECOVERING, grace); supervisor (subscribe/resubscribe, single socket, ping,
  jittered capped backoff, silence watchdog, clean stop); REST (429 retry/backoff, API error fail-fast); collector
  end to end (routing, dedupe after reconnect replay, quarantine of unparseable/unknown/invalid, wrong-interval
  REST rows quarantined, book gap → exactly one resubscribe → recovery, cached metadata on restart, hard failure
  with no metadata); HTTP (localhost Host check, 405, param validation, path traversal, no CORS, no secret or
  internal-path leakage).
* **Mutation check:** the suite was re-run with three safeguards deliberately broken (seq check removed; partial
  candle allowed to overwrite final; pong refreshing feeds). Each mutant failed the suite (2, 1 and 1 failures).
  The code was restored and the suite passed again.

## V-005 Live smoke (cloud container, real Bitget public data) — 2026-11-16 ~07:55 and ~07:58 UTC
* `NODE_USE_ENV_PROXY=1 npm run smoke` (30 s, BTCUSDT/ETHUSDT/XRPUSDT perps): **pass**. Each symbol has persisted
  real trades (recv ≥ exch, persist ≥ recv), 1m candles, a ticker with distinct last/mark/index, and a VALID uncrossed
  book read back through `http://127.0.0.1:8799/api/*`. All 15 feeds HEALTHY. Clock offset +8 ms (RTT 209 ms).
  0 quarantined, 0 dropped.
* Observed cadence (25 s window): ticker max gap ~0.2 s; books ~0.3 s; BTC trades 1.4 s; XRP trades up to 7.7 s;
  candle pushes up to 6.9 s for XRP. The initial stale thresholds (ticker 10 s, books 10 s, trade 60 s, candles 20 s)
  sit above these. **A 25-second sample is not a cadence study**; thresholds are to be re-checked on a long run (B-05).

## V-006 Live restart (same DB, second run) — 2026-11-16 ~07:59 UTC
* Before: trades 418, candles 6003. After a 12 s second run: trades 566, candles 6003; 82 replayed trades and 8985
  re-delivered candle rows were recognised as **unchanged** (no duplicates). 0 quarantined. Exactly one forming
  candle per series; latest 1m open advanced to 07:59.
* Not covered live: a mid-run network cut. Disconnect/reconnect is covered by fixture tests only (V-004).
