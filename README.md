# alexismeta — Bitget edge dashboard

A public dashboard for BTC/ETH/XRP USDT-margined perpetuals on Bitget, plus the research lab
(`bgbot/`) that tests whether a simple strategy has an edge after fees, funding, slippage and leverage.

**No API keys, no account access, no orders.** Everything on the site is public market data.

## What's here
| Path | What it does |
|---|---|
| `docs/index.html` | The website: live 15m chart with named patterns marked on it, a "right now" read, crowd positioning, the 100x maths, and a report card of every pattern |
| `docs/patterns.js` | The pattern engine. One file, used by the site AND by the history test |
| `docs/SOURCES.md` | Which videos / PDFs the rules came from and what was adapted |
| `scripts/fetch_market.py` | Public Bitget data -> `data/market.json` (every 15 min) |
| `scripts/analyze.js` | Current read per coin -> `data/read.json` |
| `scripts/fetch_history.py`, `scripts/pattern_stats.js` | 180 days of 15m candles -> what each pattern actually did -> `data/stats.json` (daily) |
| `scripts/publish.sh` | Publishes `docs/` to the `gh-pages` branch, which is what the site serves |
| `tests_js/`, `tests/` | Node: engine, worker and ledger tests (`npm test`); Python: 22 lab tests (pytest) |
| `server/` | Local worker: Bitget public collector -> SQLite -> local API + this site on http://127.0.0.1:8787 (see below) |
| `devdocs/` | Engineering records: audit, requirements matrix, decisions, verification log, runbook, resume notes |
| `bgbot/`, `config/` | The research lab (see `LAB.md`) |

Site: https://art3mis9732.github.io/alexismeta/  (served from the `gh-pages` branch)

Run locally:
```powershell
python scripts/fetch_market.py; node scripts/analyze.js
python scripts/fetch_history.py --days 180; node scripts/pattern_stats.js
node --test tests_js/patterns.test.js
```

## Local worker (optional, runs on your PC)
Needs Node.js 22.13 or later and **no** npm packages. It collects Bitget public data continuously while the PC is on,
stores it in `data/worker/market.db`, keeps an append-only decision ledger, and serves the site with live
feed-health labels. It contains no order-placement code.
```powershell
npm test          # engine + worker + ledger tests
npm start         # then open http://127.0.0.1:8787
npm run smoke     # 30-second live check against Bitget
```
A sleeping or offline PC means gaps. They are recorded as gaps and never filled with invented data. Details are in
`devdocs/deployment-runbook.md`.

## Why the account isn't connected
A public static site cannot keep a secret. Account tools (balances, positions, demo orders) will run
locally from `bgbot/` with a read-only, IP-bound, withdrawal-disabled key held in an environment
variable, never committed and never sent to a browser.
