# Decision log

Format: problem → options → choice → why → cost → verification → reversibility.

## D-001 Engineering docs live in `devdocs/`, not `docs/` (2026-11-16)
`docs/` is the GitHub Pages root and `publish.sh` publishes all of it. The two prompts' document lists were merged
into one set to avoid duplicate status pages:
`requirements.md` (traceability matrix), `repository-audit.md`, `roadmap.md` (implementation plan),
`data-sources.md` (capability registry), `decisions.md`, `blockers.md`, `verification.md` (validation report),
`progress.md`, `deployment-runbook.md`, `resume.md`. Reversible: rename the folder.

## D-002 Persistent worker = zero-dependency Node service in `server/` (2026-11-16)
* **Problem:** a static site plus a 15-minute cron cannot supply continuous collection, persistence, a ledger or
  health monitoring.
* **Options:**
  (a) Python/FastAPI worker. It would reuse `bgbot` sizing/OMS, but would need the JS engine ported or run in a
  subprocess, and it adds FastAPI, uvicorn and an async WebSocket client.
  (b) Node worker. It reuses `docs/patterns.js` directly (one engine for browser, cron and worker), and Node ≥ 22.13
  ships `fetch`, `WebSocket`, `node:sqlite` and `node:test` built in, so it needs **no npm dependencies** and has no
  lockfile risk.
  (c) Microservices plus Redis/Postgres. Rejected: no demonstrated need.
* **Choice: (b).** The strategy rules already live in JS. Python remains the research lab. Where Python sizing or
  OMS logic is needed in the worker it will be ported **with cross-language fixture tests** (same inputs, same
  outputs) rather than duplicated blindly.
* **Cost:** free. Requires Node ≥ 22.13 on the user's machine (where `node:sqlite` is unflagged). `node:sqlite` is
  still marked experimental, so the storage layer is isolated behind `server/store.js` and could be swapped for
  `better-sqlite3` if it breaks.
* **Verification:** worker tests in `tests_js/`, plus a live smoke test (`npm`-free: `node server/main.js --smoke`).
* **Reversible:** yes. The worker is additive; the static site works without it.

## D-003 Storage = SQLite (WAL) via `node:sqlite`, single writer (2026-11-16)
One process writes. Retention is bounded per table (see `data-sources.md`). PostgreSQL only if a second writer or
remote hosting is approved. DB path: `data/worker/market.db` (git-ignored `/data/`). Dev and test DBs use separate
paths (tests use in-memory DBs).

## D-004 Stay on Bitget **Classic v2** public REST + WS (2026-11-16)
The repository uses `/api/v2/mix/...` and `wss://ws.bitget.com/v2/ws/public` consistently. UTA v3 market endpoints
exist, but public market data does not depend on account mode, and mixing schemas is forbidden. Classic docs now
live under `https://www.bitget.com/legacy-docs/classic/` (accessed 2026-11-16). Account migration: **not done and
not to be done.** Revisit only if Bitget announces retirement of the v2 public endpoints.

## D-005 Never edit frozen `PARAMS` / legacy profiles in place (2026-11-16)
`stats.json`, `model.json` and the forward journal are keyed to `patterns.js` `PARAMS`/`PROFILES`. New analyst
policies (Risk Taker / Balanced / Defensive) are **new versioned policies alongside** the legacy profiles. Legacy
results remain visible, labelled "legacy v0".

## D-006 Public site must keep working with no backend (2026-11-16)
The worker serves `docs/` itself on `localhost` and exposes `/api/*`. The site probes `/api/health` on the same
origin. On GitHub Pages that probe fails, and the site behaves exactly as today, labelled "browser stream / static
snapshot".

## D-007 Order-book integrity uses observed `seq`/`pseq` chaining (2026-11-16)
The official classic best-practices page says `books` = snapshot, then incremental updates. It does not specify a
continuity rule. A live probe (2026-11-16 07:46 UTC) showed every `books` update carrying `pseq` = the previous
message's `seq`. The adapter treats `pseq ≠ lastSeq` as a discontinuity: book INVALID, dependent features blocked,
resubscribe. This rule is labelled **"observed, not documented"**. Additional checks: crossed book, negative size,
unsorted levels.

## D-008 Trade `side` is stored raw; aggressor meaning is UNVERIFIED (2026-11-16)
Official classic docs found so far do not define `side`. Third-party wire-format docs say it is the taker side.
Stored as `venue_side`. Any CVD or aggressor feature carries the flag `aggressor_semantics=unverified` until an
official source confirms it.

## D-009 Candle finality comes from bar-end evidence, never from "a newer bar appeared" (2026-11-16)
A bar is final only when a message stamped at or after its close says so: a WS push or a REST `requestTime`. When a
newer bar opens, the collector does **not** mark the old bar final with its last partial values; it re-fetches over
REST (V-009). Reason: the last WS push can come seconds before the close, so its values can be incomplete.

## D-010 Coverage gaps are explicit rows; observation end = last frame / clean shutdown time (2026-11-16)
Downtime, disconnects and invalid books are written to `coverage_gaps`. Features and replay must call `coverage()`
and return UNKNOWN on incomplete windows. A silent trade channel while ticker and book flow is *observed*, not a gap.

## D-011 Ledger rows carry a hashed `data_mode` (LIVE | REPLAY) (2026-11-16)
Added in schema v3 before any ledger row existed outside tests, so no hashes had to be migrated. Replay runs may use
the same DB, but their entries can never verify as LIVE.

## D-012 Analyst v1 policies wrap the legacy engine's triggers; legacy profiles stay untouched (2026-11-16)
Balanced v1 = the legacy Neutral entry rule; Defensive v1 = legacy Careful plus spread/depth limits; Risk Taker v1 =
broader triggers plus one explicit flat-trend reclaim rule. All three read one evidence-v1 snapshot at a 15m close
(not the legacy 5m range scalp, which stays as legacy v0). Reason: one shared, hashed input makes the analysts
comparable, and reusing the measured engine keeps the history-tested trigger definitions. Rules are tabulated in
`server/policies.js`; changing any number means a new version id.

## D-013 Paper exits use the trade tape, not candles (2026-11-16)
The worker persists every public trade, so stop/target ordering is decided by the actual sequence of trades. There is
no "both touched in one candle" ambiguity in forward paper trading. Historical replay without a trade tape will need the
conservative stop-first rule, labelled as such. Stops fill at the worse of the stop and the crossing trade; targets fill
as taker at the target minus slippage. A recorded trade-feed gap makes the outcome unevaluable.

## D-014 Paper risk defaults = master prompt §11 engineering defaults; exchange leverage setting 2x (2026-11-16)
Not personalised advice and not shown to be optimal. The legacy browser profiles still show 50x/10x/3x on $5 for
continuity; the v1 analysts never exceed 2x notional/equity.

## D-015 Coverage required = coverage of what the features consume (2026-11-16, after a live 1-second disconnect)
A real disconnect at 08:36:47 (reconnected within 1 s) put a gap inside the 15-minute window, and the original rule
then blocked every decision for 15 minutes. That is stricter than the evidence needs: evidence-v1 reads REST-complete
candles and the ticker and book **at decision time**, and no trade-tape features. New rule: ticker and book must be
observed continuously for the last 60 s, so any reconnect in that minute means NO_TRADE, because the book may not be
resynchronised. Trade coverage is required only by features that use trades; v1 has none. Paper exits still mark any
trade gap while a position is open as unevaluable. Future trade-based features (CVD, trade-size percentiles) must
declare their own coverage window.

## D-016 Data-gap accounting: keep the position, flag the path, fill only at observed prices (2026-11-16)
See `financial-audit.md`. Options considered: (a) close at the stop price by assumption — rejected, invents a fill;
(b) delete or void the trade — rejected, lets missing data improve results; (c) keep everything, mark the outcome
uncertain, show both totals — chosen. Stressed alternative branches and portfolio quarantine are not built.

## D-017 Environments are a property of the database, fixed at creation (2026-11-16)
`meta.environment` = FORWARD or TEST. The worker refuses to open a database under the other environment, the fixture
driver refuses FORWARD, and every API envelope, decision payload and UI banner carries the environment. A test fixture
can therefore never write to, or be displayed as, the forward ledger. Recorded-market replay keeps using `data_mode`.

## D-018 Browser updates = REST snapshot + server-sent events from an outbox (2026-11-16)
Why SSE: one-way, built into browsers, automatic reconnect with `Last-Event-ID`, no dependency. Durable events are
rows in `paper_events`, written in the same transaction as the state change, and read by cursor, so they cannot be
dropped; valuation frames are coalesced. The client rejects duplicates and resnapshots on any gap. Polling remains as
a fallback where `EventSource` is missing.

## D-019 The browser is never a paper engine (2026-11-16)
All P&L, valuation and account figures come from the worker. On worker loss the last values are frozen and labelled.
The legacy manual "Start paper trade" simulator on Buy/Sell is kept for continuity but labelled as a browser-only
sandbox outside every account total; replacing it with ledger-backed setups is listed in the tab inventory.

## D-020 News items are keyed by canonical URL; each source has its own link-host allowlist (2026-11-16)
`press_monetary` repeats `press_all` items; keying on (source, guid) would double-count them. A story is one row with a list of
source references; the first source stays primary and only it can revise the stored text. Links must be https on the host(s)
declared for that source, so a look-alike or foreign host in a feed is dropped. Exchange/issuer items are labelled
INTERESTED_PARTY_CLAIM and are never independent corroboration.

## D-021 Interpretations are append-only and versioned by RUN (2026-11-16)
A row per (item, content hash, interpreter version, asset) plus a run record per (item, hash, interpreter). A corrected rule adds a
new run (possibly "not applicable") and never edits or deletes the earlier one; a point-in-time view picks the latest run that
existed at that time. UNAVAILABLE (never interpreted, or the interpreter failed) is distinct from NOT_APPLICABLE and from NEUTRAL.
No numeric score or probability exists in the schema; the LLM interpreter slot is registered as disabled.

## D-022 Do not restart the forward worker while it holds open paper positions (2026-11-16)
Every restart is a data gap; under D-016 it flags each open position as unresolved and excludes its outcome from path-dependent
metrics. Demonstrated live (V-027). Code changes are verified on the TEST worker and on COPIES of the forward database; the
forward worker is restarted only when no position is open, or when the user accepts the gap. The browser suite skips and reports
forward-only checks when the forward build differs from the tree instead of forcing a restart.

## D-023 (2026-11-17) — a UI task is not done until the rendered page has been looked at
Four layout defects (V-029) passed every API and DOM-text test because those tests never measured geometry. Rule: UI changes are verified
by reading rendered screenshots (desktop and phone) and each repaired layout defect gets a browser assertion on geometry or computed
range that is **mutation-verified** (the fix is reverted and the check must fail). A check that passes without its fix is a weak check
and is rewritten (it happened once: the clipped-accounts check ran on a page where the defect did not reproduce).

## D-024 (2026-11-17) — the stress policy ships in SHADOW; enforcing it is a user decision
Calibration is modest (BTC/ETH lift only, XRP none, liquidity families uncalibrated, reactive timing). Enforcing blocks forward entries, which changes forward strategy behaviour and comparability. Default everywhere: `SHADOW` (record `would_block` in the ledger, block nothing). `--stress-mode enforce` exists but needs the user's explicit approval and a recorded effective time (shown in `/api/stress`). Read the SHADOW record first.

## D-025 (2026-11-17) — stress may only block NEW entries
No exposure reduction, forced exit, size scaling or re-pricing exists. Stress is read inside `risk.evaluate` at authorisation and never in `manage()`, accounting, or valuation. Stale monitor, missing state, warm-up and unreliable data all count as "unsafe to open", never as NORMAL.

## D-026 (2026-11-17) — the recovery window applies only after a real outage
Found with live data: websocket drops every 10-13 minutes would, with a 5-minute window after every blip, block entries most of the time. The existing gate already applies a 60 s coverage rule to blips. After an outage of >= 5 min (including a monitor that was not running) usable data must persist for 5 more minutes. DEGRADED is usable.

## D-027 (2026-11-17) — no forward restart while positions are open; the v9 migration waits
The forward worker holds two open natural positions (flagged by a real websocket gap). D-022 stands: it keeps running the older build, the migration is validated on a copy and applies at the next restart with no open position (backup first, just after a bar close). The stress monitor therefore is not yet watching the forward environment.

## D-028 (2026-11-17) — event closure after an unobserved gap is UNOBSERVED, not RECOVERED
When the monitor was not running for more than 5 minutes, an active event is closed at the last evaluation time with reason UNOBSERVED. A disconnect or restart is never recorded as a recovery.
