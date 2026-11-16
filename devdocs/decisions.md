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
