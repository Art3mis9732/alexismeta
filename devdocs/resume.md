# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`. Remote is at `e3034ae` (pushed 2026-11-16 11:31 UTC with explicit approval
for that range). Each further push needs its own approval (third prompt). No PR, merge or deploy.
**State:** stages A–C of the third prompt verified; D partial. `npm test` 129/129; `tests_e2e/monitor.e2e.js` 28/28;
`tests_e2e/status.e2e.js` 23/23; pytest 22/22. Evidence V-019…V-023; audit in `financial-audit.md`; tabs in
`tab-inventory.md`.

## Where things are
* Monitor: http://127.0.0.1:8787/ → first tab "Paper monitor" (worker must be running: `npm start`).
* Forward ledger: `data/worker/market.db` (git-ignored; 36 decisions, 0 positions at 11:00 UTC). Export of the first 18
  rows: `devdocs/evidence/forward-ledger-2026-11-16.json`. In this cloud container the database is lost when the
  container is reclaimed: export again before ending a session.
* TEST environment: `node server/main.js --port 8791 --env test --fixture` (database `data/worker/test-fixture.db`).

## Next exact steps
1. Natural forward track: keep the forward worker running; when the first entry/exit appears, record it (V-0xx) and
   check the monitor shows it. Do not loosen any gate.
2. Stage D remainder: per-detector detection/confirmation times; ledger setup markers on the chart; replace the legacy
   manual sandbox with ledger-backed setups; history filters (analyst/version/asset/date); contrast + screen-reader pass.
3. Stage F before any model work: feature availability matrix; candle-only research baseline clearly separate from v1;
   costs; baselines. The legacy 180-day test of the reused entry rules is NEGATIVE after fees: start from that.
4. Stage E: news filters and more official sources (ECB, exchange status), still context only.
5. Stage G/H: real job runner (bounded, cancellable) before any "training" UI; baselines + calibration gate.
6. Reliability: backup-restore drill, DB-corruption drill on a copy, Windows start, auth before any hosted API.

## Running processes (cloud container)
* Forward worker 8787; TEST worker 8791; static server 8788. Stop: `pkill -INT -f "main[.]js"`; `pkill -f "http[.]server 8788"`.

## Environment notes
* Cloud container: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`.
* Check `/api/runtime` fingerprint against the working tree before trusting a running worker.
* No Firecrawl or other metered service without explicit approval. Tested runtime: Node 22.23.4 on Linux only.
