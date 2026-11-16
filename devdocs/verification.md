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

## V-007 Append-only ledger (Phase 2b) — 2026-11-16 ~08:05 UTC
* `npm test`: **55 pass, 0 fail** (8 new ledger tests + an HTTP ledger check).
* Verified: DB triggers reject UPDATE/DELETE (including from the app); retention never touches the ledger; identical
  re-append is idempotent while changed content under the same id is refused; `data_cutoff_ts > created_ts` refused;
  an outcome before `eval_due_ts` is refused; status/outcome must reference an existing original; SHA-256 chain
  verifies and **detects an edit made after dropping the trigger** (first bad seq reported); the chain continues
  across a restart; an existing v1 DB upgrades to v2 without losing data.
* Live: the smoke DB from V-005/V-006 (schema v1) was opened by the new build, migrated to v2, and the 8 s live smoke
  passed.
* Limitation: a local file can be replaced wholesale. Detection needs the chain head stored elsewhere (e.g. committed
  daily or written to the backup log). Not yet implemented; listed in the roadmap.

## V-008 Browser status labels (Phase 3) — Playwright 1.63 / Chromium, cloud container, 2026-11-16 ~08:10 UTC
* `node tests_e2e/status.e2e.js http://127.0.0.1:8787/ http://127.0.0.1:8788/` against (a) the worker serving `docs/`
  and (b) `python -m http.server` serving `docs/` (no `/api`, like GitHub Pages), with the published gh-pages
  `data/*.json` copied into the git-ignored `docs/data/`. **15/15 checks pass.**
* The run found and fixed two bugs:
  1. `loadSnapshot()` parsed any response body as data. A JSON 404 (`{"error":"not found"}`) became `MARKET` and
     crashed rendering ("Cannot read properties of undefined"). GitHub Pages returns HTML 404s, which failed
     to parse and so masked the bug. Now only 2xx responses are parsed, and `MARKET` must have `symbols`.
  2. The status label stayed "connecting…" for up to 5 s after the socket opened. `setMode()` now runs on open.
* Defect A-01 is verified fixed in a real browser. With real data for 8 s and then only pongs (Playwright
  `routeWebSocket` drops the data frames and answers pings), the label went `● LIVE …` → `◐ STALE · connected, but no
  BTC market data for 11 s`. A socket that never delivers data shows `◐ RECOVERING`, never LIVE.
* Defect A-02 is verified fixed: the model card reads "Model scores (uncalibrated, not probabilities)", the column
  is "Score (uncalibrated)" with values shown as 0.502 rather than 50.2%, and the card explains that test metrics
  come from the 70% model while the live model is refit.
* Existing workflows: Buy/Sell, Patterns and Indicators views render; coin switch works; no page errors in either mode.
* An apparent issue that turned out to be correct behaviour: right after load only BTC data had arrived, so switching
  to ETH within about 1 s showed `◐ RECOVERING` until the first ETH message arrived about 1 s later. The label was true at
  that moment. The e2e test now also asserts that the label then reports ETH data.
* Not verified: Firefox/Safari, mobile layouts, keyboard navigation, screen readers.

## V-009 Steady-run candle finality — a real bug, found and fixed (2026-11-16 08:13–08:20 UTC)
* **Finding:** after 1 min 18 s of uninterrupted running, the 08:13 BTC 1m bar was still `final=0` at 08:14:46. Its last
  WS push was at 08:13:57, before the close, and nothing finalised it. All earlier runs were under 30 s and restarts
  re-finalised bars through REST, so the fixture tests and the smoke runs had not exposed this.
* **Fix:** collector finaliser. When a new bar opens on the stream, closed bars still `final=0` are re-fetched over
  REST 2.5 s later; REST rows are final by `requestTime`, and the store's upsert rules let a final row replace the
  partial one. A 30 s sweep is the backstop. Bars REST cannot return yet are logged (`candle_not_finalized`).
* **Live result (same container, restarted with the fix):** XRP 08:15 was finalised by REST at 08:16:03. Some BTC bars
  (08:14, 08:15) were finalised by the stream itself, because Bitget pushed an update stamped exactly at the bar close
  (08:15:00, 08:16:00). Both paths now end with `final=1`.
* Fixture test: "a bar the stream never finalised is finalised from REST after the next bar opens". Removing the trigger
  makes it fail (mutation check).

## V-010 Coverage gaps, real SIGINT, unclean-stop detection
* A real `SIGINT` (`pkill -INT`) of the long-running worker logged `shutdown`; the restart recorded per-instrument
  `downtime` gaps for trade, ticker and book starting at the logged shutdown time. **D-14 SIGINT path verified live.**
* Fixture tests: a disconnect gap starts at the last frame received (not at the close event); an invalid book creates a
  `book_invalid` gap until a fresh snapshot; a simulated power loss (DB closed without stop or shutdown) is detected on
  restart (`lastWorkerEvent()` = start), and the gap starts at the last message of **any** kind, because a quiet trade
  channel is not unobserved time; `coverage()` reports `gap_in_window` and `observation_started_after_window_start`.
* First live run showed the original rule started the XRP trade gap at the last XRP trade (8 s before shutdown),
  marking observed time as unobserved. Corrected as above.
* Ledger `data_mode` (LIVE/REPLAY) is hashed. Relabelling a replay row as LIVE after dropping the trigger is detected by
  `verify()`, and a REPLAY outcome cannot attach to a LIVE original.
* `npm test`: **59 pass, 0 fail**.

## Unverified claims (explicit)
* **Node 22.13.0 minimum:** the suite has only run on Node 22.23.4. Fetching and running a 22.13.0 binary in this
  container was refused by the session's permission classifier, so the stated minimum (`engines`, CI pin, README) is
  the documented `node:sqlite` unflagging version, **not a tested one**. CI (`tests.yml`, pinned to 22.13) will test it
  on the first PR or main push.
