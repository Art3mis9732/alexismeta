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
