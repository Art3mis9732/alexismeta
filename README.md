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
Needs Node.js 22.23 or later (the tested version) and **no** npm packages. While the PC is on it:
* collects Bitget public data (BTC/ETH/XRP USDT perpetuals: ticker, trades, full order book, 1m/5m/15m/4h candles) into
  `data/worker/market.db`, with health checks, gap records and book-integrity checks;
* at every 15-minute close, has three analysts (Risk Taker, Balanced, Defensive, v1) read one shared evidence snapshot,
  runs an independent risk gate, and **paper**-trades approved setups in separate 1,000 USDT virtual portfolios;
* records every decision, risk check, fill and outcome in an append-only, hash-chained ledger;
* lists official Federal Reserve and SEC press releases as context (not a trading signal);
* serves this site at http://127.0.0.1:8787 with prices taken from the worker (one exchange connection per PC);
* shows a **News** tab: official Federal Reserve and SEC releases plus Bitget and OKX announcements, with per-source health, relevance counts,
  rule-based interpretations (potential direction only, no probabilities) and observed price reaction since discovery; context only, never a trade signal;
* shows a live **Paper monitor** tab (the first tab): accounts, open positions with mark-based and close-now figures,
  position detail, activity timeline and "why no trade" diagnostics, all computed by the worker and streamed to the page.

It contains **no order-placement code**. Paper results so far are far too few to show any edge: the site says
"No demonstrated edge".
```powershell
npm test          # engine + worker + ledger tests
npm start         # then open http://127.0.0.1:8787
npm run smoke     # 30-second live check against Bitget
node server/admin.js status                 # paper portfolios, open positions, ledger check
node server/admin.js kill-switch on all     # stop new paper setups (open positions keep their exits)
node server/admin.js backup data/backup.db  # consistent copy + integrity check
```
A sleeping or offline PC means gaps. They are recorded as gaps and never filled with invented data. Details are in
`devdocs/deployment-runbook.md`.

## Why the account isn't connected
A public static site cannot keep a secret. Account tools (balances, positions, demo orders) will run
locally from `bgbot/` with a read-only, IP-bound, withdrawal-disabled key held in an environment
variable, never committed and never sent to a browser.
