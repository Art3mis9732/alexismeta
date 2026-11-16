# Deployment & operations runbook

## Current production (unchanged by this work)
* Site: GitHub Pages from the `gh-pages` branch, built by `scripts/publish.sh` in `snapshot.yml` (every 15 min and
  on push to `main` for `docs/**`, `scripts/**`, `bgbot/**`) and `stats.yml` (daily).
* **Any merge to `main` publishes immediately.** Merging requires explicit user approval (P2§15).

## Local worker on Windows (PowerShell) — instructions, NOT yet executed on Windows (B-03)
Requirements: Node.js 22.13 or later (LTS 22 or 24) from nodejs.org; Git. No npm install is needed.
```powershell
cd $HOME\path\to\alexismeta
node --version                      # must be v22.13.0 or later
npm test                            # all JS tests (engine + worker); npm ships with Node, nothing is installed
npm start                           # collector + http://127.0.0.1:8787   (or: node server\main.js)
npm run smoke                       # 30 s live check against Bitget, prints a pass/fail report
```
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
