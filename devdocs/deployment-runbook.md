# Deployment & operations runbook

## Current production (unchanged by this work)
* Site: GitHub Pages from the `gh-pages` branch, built by `scripts/publish.sh` in `snapshot.yml` (every 15 min and
  on push to `main` for `docs/**`, `scripts/**`, `bgbot/**`) and `stats.yml` (daily).
* **Any merge to `main` publishes immediately.** Merging requires explicit user approval (P2§15).

## Local worker on Windows (PowerShell) — instructions, NOT yet executed on Windows (B-03)
Requirements: Node.js **22.23 or later** (the only version actually tested; `node:sqlite` exists from 22.5 and is unflagged from 22.13, but older versions were not tested) from nodejs.org; Git. No npm install is needed.
```powershell
cd $HOME\path\to\alexismeta
node --version                      # v22.23.0 or later
npm test                            # all JS tests (engine + worker); npm ships with Node, nothing is installed
npm start                           # collector + http://127.0.0.1:8787   (or: node server\main.js)
npm run smoke                       # 30 s live check against Bitget, prints a pass/fail report
```
Admin (safe while the worker runs):
```powershell
node server\admin.js status
node server\admin.js kill-switch on all      # or: on balanced / off all
node server\admin.js verify-ledger
node server\admin.js backup data\backups\market-2026-11-16.db
```
Restore = stop the worker, copy a backup over `data\worker\market.db`, start the worker. The restart is logged and
the downtime is recorded as a coverage gap. A restore drill has **not** been run yet.

Then open http://127.0.0.1:8787 in a browser. Stop with Ctrl+C (graceful shutdown flushes and closes the DB).
Data is stored in `data\worker\market.db` (do not commit it).

Python lab (unchanged):
```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pytest -q
```

## Rollback
* Code: the worker is additive (`server/`, new tests, `devdocs/`). Reverting those commits restores the original
  behaviour. The site keeps working without the worker (D-006).
* Data: delete `data\worker\` to reset the worker DB. **Never** delete the ledger without a backup once Phase 2b
  exists.

## Storage projection (measured 2026-11-16, 10-minute sample, BTC+ETH+XRP perps; NOT a long-run study)
| table | rows/hour | retention | steady-state rows | approx size |
|---|---|---|---|---|
| trades | ~47,000 | 3 days | ~3.4 M | ~0.7 GB |
| book_tops (20 levels, 1/s) | ~10,400 | 2 days | ~0.5 M | ~0.75 GB |
| tickers (1/s) | ~10,000 | 7 days | ~1.7 M | ~0.4 GB |
| candles (1m/5m/15m/4h) | ~290 | 1m: 90 days, others kept | ~0.4 M after 90 days | small |
Expect roughly **2 GB** of disk at steady state (average ~300 bytes/row including indexes, from a 20 MB DB holding
~57k rows). Busy markets produce more trades. Lower the retention in `server/store.js` (`DEFAULT_RETENTION_MS`) on small
disks. Known limit: retention runs hourly as one DELETE per table, so the first prune after a long downtime can pause
the worker briefly. Health row counts are cached for 60 s for the same reason.
