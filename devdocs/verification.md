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

## V-011 Worker-fed page: exchange → SQLite → API → UI with no per-tab collector (Phase 2/3 gate)
* The worker now also collects `candle5m` and `candle4H` (the page uses 5m, 15m and 4h). When the page is served by the
  worker, it takes tickers and candles from `/api/*` (2 s poll) and does **not** open a Bitget socket.
* `tests_e2e/status.e2e.js`: **18/18 pass** (2026-11-16 ~08:19 UTC, Chromium). New checks: label says "via local
  worker"; **0 Bitget WebSockets opened by the tab over 6 s**; displayed BTC price (64567.6) equals one of the last
  `/api/ticker` values the page received (64577.7, 64566.2, 64570.3, 64567.6).
* `tests_e2e/fallback.e2e.js`: with a worker-fed page open, the worker was stopped (SIGINT). The strip changed to
  "Local worker stopped responding — switched to this browser's own Bitget stream", the label went back to
  `● LIVE · Bitget public data`, and the tab opened its own socket. **PASS.**
* Missing funding now shows "unknown" instead of "NaN%".
* Limits: the page polls every 2 s, so worker-mode display latency is up to about 2 s plus render time. Multiple tabs
  each poll the local API, which is cheap and never reaches the exchange.

## V-012 Risk gate, evidence, policies, paper engine (fixtures) — 2026-11-16 ~08:25 UTC
* `npm test`: **86 pass, 0 fail**.
* Sizing: the JS port matches `bgbot/sizing.py` on **864** generated cases (508 sized; 356 rejected across open-risk limit,
  minimum size, minimum notional and liquidation distance), never exceeding the per-trade budget or the 2x cap.
* Risk gate: identical mandatory data checks for all analysts; daily loss and drawdown include unrealised P&L; kill
  switch; correlated bucket (open risk and notional across BTC/ETH/XRP); one position per coin; S8 minimum-size NO_TRADE.
* Evidence: deterministic hash; gaps, non-final bars, a missing last bar, short history, a post-decision ticker or book
  are all listed as missing; depth from the full book; **a forming bar after the decision close does not change the
  snapshot** (mutation-tested: including that bar makes the test fail).
* Policies: pre-registered S1–S7 produce exactly the expected Risk Taker / Balanced / Defensive outcomes; no exit
  intent without a position; cooldown; contradicting evidence recorded; no probability is emitted (`score: null`).
* Engine: S3 → 3 decisions → 3 approvals → 3 fills at ask × (1 + 2 bps); ledger kinds in order; trade-tape exits
  (1.5R targets hit, 2R not, then stop); stop gapped through fills at the worse trade price; a coverage gap makes the
  outcome unevaluable and excluded from stats; funding charged at settlement at the last observed rate; time exit at
  the bid; a retried bar close does not trigger twice; kill switch and daily-loss state persist across a restart; the
  kill switch keeps managing open positions; `tick()` never decides on bars that closed before start.
* Two test-data bugs were found and fixed while writing these tests (not engine bugs): `String(1e18 + n)` made every
  synthetic trade id equal, so they were correctly deduplicated; Risk Taker's 4 h time exit coincided with the
  funding test's settlement. One engine flaw was fixed: a retried bar close now checks the ledger before deciding,
  instead of failing on a content mismatch.

## V-013 Analysts card (Playwright) — 2026-11-16 ~08:31 UTC
* `tests_e2e/status.e2e.js` against the long-running worker (port 8790) and the static server: **20/20 pass**. In
  worker mode the card shows all three v1 analysts with "No demonstrated edge" and no probability; on the static page
  it is hidden.

## V-014 Official news ingestion (Phase 6, first slice) — 2026-11-16 ~08:36 UTC
* Sources probed from the cloud container: Fed `press_all.xml` and SEC `pressreleases.rss` → HTTP 200 RSS
  (20 and 25 items). A generic client name was used (no personal contact details).
* **Adversarial finding:** the Fed intermittently served its HTML "Page not Found" page **with HTTP 200** at the feed
  URL; the immediate retry returned RSS. The ingester rejects non-RSS documents (`fed_soft404.html` fixture → quarantined).
* `tests_js/news.test.js` **7/7**: real fixtures parse (https official links, publication times); re-polling adds
  nothing; a publisher revision is kept and **a point-in-time view before it shows the original wording**; nothing is
  visible before its discovery time; embedded instructions and markup are inert text (and policies/risk do not import
  news); non-https/foreign links dropped; deterministic tags; syndicated titles share a cluster id; redirects refused
  (incl. to 169.254.169.254); bodies over 2 MB rejected; 304 handled; ETag stored.
* Live worker (port 8787, separate DB): both sources `ok`; `/api/news` serves items with publisher, URL, published and
  discovered times. Playwright **21/21** including "official news listed with https .gov links opened safely (noopener)".
* Limits: two official sources only. No CFTC/COT, FRED, ETF issuer data or exchange announcements yet. No
  interpretation; news does not feed any policy (any future use must be evaluated by ablation, per the prompt).

## V-015 Engine hardening + replay verification — 2026-11-16 ~08:43 UTC
* Final-candle stability (offline check of `long.db`): of 45 1m bars from 08:15–08:29, 28 were finalised by the stream
  and the rest by REST; the 08:30:34 restart's REST backfill found **identical values for all 45** (0 rewritten).
  D-009 holds on this sample.
* Stalled channel: if ticker or book goes STALE while the socket stays open (pongs only), the collector records a
  `stalled_channel` gap from the last data and forces a reconnect (fixture test). Previously only total silence
  triggered a reconnect, and no gap was written.
* Time exit now requires a ticker under 10 s old and a healthy ticker feed; an exit while the feed is unhealthy (an
  outage whose gap row is written only on reconnect) is marked unevaluable.
* Decision payloads now include the policy context (`position_open`, `cooldown_until`).
* Risk gate: `DEPTH_UNKNOWN` and `SIZE_VS_DEPTH` (notional ≤ 10% of the visible depth within 10 bps on the side taken).
* `server/replay.js --verify`: for a real builder snapshot, 3/3 recorded decisions reproduced exactly; editing the stored
  snapshot is detected (hash mismatch). `npm test` **97 pass, 0 fail**.

## V-016 Live bar-close decisions + a real disconnect (long-run worker, port 8790) — 2026-11-16
* **08:45 bar:** 9 decisions written at 08:45:07 (bar close + 7 s), 3 analysts × 3 coins, **one evidence hash per coin
  shared by all three analysts**. All `NO_TRADE COVERAGE_GAP`: the worker restarted at 08:30:34, inside the 15-minute
  window used by that build. Snapshots: `missing: []` (final, contiguous candles); `data_cutoff_ts` 44–45 ms before
  the decision; full-book depth within 10 bps (min side): BTC ≈ 21.4 M, ETH ≈ 6.1 M, XRP ≈ 0.25 M USDT; spreads
  0.015 / 0.055 / 1.046 bps. Only the abstention path was exercised live; fills and exits are fixture-verified only.
* **Real disconnect at 08:36:47:** the socket closed (cause unknown: server or proxy side). The worker reconnected within
  1 s, wrote `ws_disconnect` gaps (08:36:47–08:36:48) for trade/ticker/book × 3 coins, re-ran the REST candle backfill
  and logged `possible_trade_gap`. This is live evidence of the reconnect path.
* That 1-second gap would have blocked decisions for 15 minutes under the original rule, so coverage was re-scoped to
  what v1 consumes (D-015). Fixture test added; `npm test` **98 pass**.

## V-017 Display timezone selector — 2026-11-16 ~08:48 UTC
* Header selector: Asia/Kolkata (default) or UTC; fixed offsets, so there is no daylight-saving ambiguity. Storage and
  logic stay in UTC ms. Chart axis, live labels, tables and analyst/news cards follow the choice, and it persists
  across reloads. Explanatory fixed times now give both zones (e.g. "00:00–04:00 UTC = 05:30–09:30 IST").
* Playwright **23/23** against a current-code worker (port 8787) and the static server. Against the older long-run
  worker (8790, started before the news code) the news check fails only because that build has no `/api/news`.

## V-018 First fully covered live decisions — 09:00 UTC bar, 2026-11-16
* 9 decisions at 09:00:07 (3 analysts × 3 coins), one evidence hash per coin. Snapshots: `missing: []`,
  `coverage_complete: true`, data cut-off 24–38 ms before the decision, full-book depth within 10 bps (min side): BTC
  ≈ 25.6 M, ETH ≈ 10.5 M, XRP ≈ 0.27 M USDT.
* All three analysts: `WAIT NO_TRIGGER` on all coins (1h trend down and price below VWAP, but no accepted trigger;
  XRP's bar had a bearish engulfing pattern, which is not an entry trigger for any v1 policy). The analysts agreed
  because the evidence offered nothing to disagree about; disagreement is shown in the fixture scenarios (V-012).
* Post-checks ~09:00:15: recomputed `candles.rows_hash` equals the stored value for all 6 snapshots (08:45 and 09:00),
  so the final candles did not change after the decision; `verify-ledger` ok (18 entries); replay found 0 mismatches and
  0 tampered snapshots, but all 18 rows are `unverifiable_no_context` because this worker build predates context
  logging (08:43). Builds from `bffede2` on record context, and replay re-derives them exactly (fixture-verified).
* Still not exercised live: a fill, an exit, an outcome.

# Session 2 (third prompt) — 2026-11-16 10:37–11:20 UTC

## V-019 Prior-session reconciliation
* Git: HEAD `bb5ff34` = remote feature branch; reported `70ed8f1` is an ancestor (two docs commits after it); `main`
  untouched at `8de2e2a`; tree clean. **No worker was running** (the report's 8787/8790 workers had been stopped).
* Tests at `bb5ff34`: `npm test` 98/98; pytest 22/22.
* **09:00 UTC bar (2026-11-16, 14:30 IST): 9 ORIGINAL forward decisions exist**: BTCUSDT/ETHUSDT/XRPUSDT perps ×
  risk_taker-v1/balanced-v1/defensive-v1, ids `decision:<version>:bitget:perp:<SYM>:1794819600000`, written
  09:00:07.746–.799 UTC by build `86cd48b6c2f2`, `data_mode=LIVE`, all `WAIT / NO_TRIGGER`. Not replay, not missed.
  The 08:45 bar's 9 are `NO_TRADE / COVERAGE_GAP`. The Monitor from the earlier session did complete (V-018), but this
  finding rests on the persisted ledger, not on that report.
* Ledger chain ok (18 rows). Replay: 0 mismatches, 0 tampered; 18 "unverifiable" because that build did not record the
  decision context. Under the only context consistent with the data (no position ever existed) **18/18 re-derive
  exactly**. Labelled as inferred context.
* The forward database lived in a temporary folder. It was copied (`VACUUM INTO`, integrity ok) to
  `data/worker/market.db` and the ledger rows, snapshots, worker events and gaps were exported to
  `devdocs/evidence/forward-ledger-2026-11-16.json`.

## V-020 Accounting (valuation-v1, paper-v2)
* `tests_js/accounting.test.js` 12 hand-calculated fixtures: long/short ±10; close-now +9.80 gross / +8.7902 after a
  hypothetical 0.1% fee; lifecycle 7.7902 (7.2902 / 8.0902 with ∓ funding); two-level depth walk 100,974; partial
  liquidity 60% → no estimate; partial exit 5 + 17.5804 − 3.0 − 1.005 = 18.5754 and the same number after actually
  closing; multi-fill average 100,300; multiplier 0.001; inverse/USDC contracts rejected; invalid prices → null;
  duplicate fills ignored; funding signs; stale mark vs stale book; labelled percentages; account reconciliation.
* Engine tests added: cash moves when fees/funding occur and equals the facts; `reconcile()` detects a corrupted
  balance; funding/fills cannot post twice across a restart; gap policy (position stays open, flagged, fills only at the
  observed price, counted as uncertain, loss stays in the account); single writer; isolated portfolios with shared
  in-analyst risk. This found a real defect: `openRisk` double-counted entry slippage.

## V-021 Monitor backend, stream, runtime identity
* `tests_js/monitor.test.js` 7 tests: positions trace to ledger + fills; `U_mark = q·(mark − entry)`; depth-walked
  close-now; accounts independent ("3 independent paper portfolios of 1000 USDT each (total starting capital 3000
  USDT)"), reconcile, uncertain exposure; stale quotes → STALE, never silently fresh; predicate diagnostics; detail
  with a gap-marked chart; SSE (hello, 9 durable events with `prev` links, resume via `Last-Event-ID` with no replay,
  exact missed events after a partial cursor, `resnapshot` for a foreign cursor, 400 for a bad one; reading never
  creates trades); runtime fingerprint = working tree, no paths leak, cross-origin 403; TEST databases cannot be opened
  as FORWARD; `--fixture` refused outside `--env test`.
* Stale-worker guard exercised for real: after editing the page, both running workers reported fingerprint
  `95a3c16b…` against a working tree of `47749e65…`; they were restarted before any browser check.
* Measured latency (loopback, TEST worker, 27 durable events): worker `recorded_ts` → stream frame **56 / 68 / 84 ms**
  (min / median / max). Valuation frames: 1 per second; observed frame age at read 0.6–1.0 s.

## V-022 Live paper monitor in the browser — `tests_e2e/monitor.e2e.js` 28/28 (Chromium, 1440 px and 390 px)
* Step 0 asserts the served build fingerprint for both workers. TEST worker (own temp database, `--env test --fixture`):
  8 synthetic-trigger positions opened through the unchanged risk gate; monitor is the first view; PAPER label + TEST
  banner; 5 status chips with text states; displayed unrealised / close-now figures equal the backend's values; no
  exchange socket from the tab; three accounts never summed; detail via keyboard; activity filter; registry.
* Refresh: same account, no new trade, 27 events / 27 unique. Worker stopped: chips DISCONNECTED / FROZEN with the last
  timestamp, header "WORKER DISCONNECTED … not live" (never "● LIVE"), account figures unchanged for 4 s while the
  browser's fallback price feed ran. Worker restarted: page resnapshots ("worker recovered", new instance id), all 8
  positions accounted for (open or closed), same database id, accounts reconcile, no duplicated fill.
* Forward worker: exactly the ledger's positions (0), no TEST banner, predicate diagnostics, coin/timezone switch,
  keyboard navigation across all four views. Phone width: no horizontal page scroll. Static page: monitor says it needs
  the worker and shows nothing simulated.
* Lifecycle seen live in the TEST environment only: of 8 synthetic positions, 6 closed on real trades within minutes
  (stops/targets), 2 survived a worker restart. **This is engineering verification, not forward evidence.**
* `tests_e2e/status.e2e.js` 23/23 (regression). `npm test` 129/129 (incl. 6 closed-form indicator references).

## V-023 Natural forward track
* Forward ledger after restart on the preserved database: bars 10:45 and 11:00 UTC, 9 decisions each, all
  `WAIT / NO_TRIGGER`; 36 decisions in total; chain ok; **0 natural entries, 0 exits**.
* Why no entry: on every bar the blocking predicate was "accepted trigger on this bar"; data, book, coverage and
  trend/VWAP predicates were met. Warm-up satisfied (999 final 15m bars ≥ 300). Scheduler: decisions 5.8–7.8 s after
  the bar close. No rule is impossible (fixture scenarios open positions).
* Expectation from the legacy 180-day history of the same entry rule (legacy Neutral = Balanced v1's entry): 28–33
  entries per week per coin, so a natural Balanced entry is likely within hours of continuous running. The same history
  shows that rule **lost money after fees (−0.47R to −0.71R per trade)**.
