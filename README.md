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
| `tests_js/`, `tests/` | 14 engine tests (Node) + 22 lab tests (pytest) |
| `bgbot/`, `config/` | The research lab (see `LAB.md`) |

Site: https://art3mis9732.github.io/alexismeta/  (served from the `gh-pages` branch)

Run locally:
```powershell
python scripts/fetch_market.py; node scripts/analyze.js
python scripts/fetch_history.py --days 180; node scripts/pattern_stats.js
node --test tests_js/patterns.test.js
```

## Why the account isn't connected
A public static site cannot keep a secret. Account tools (balances, positions, demo orders) will run
locally from `bgbot/` with a read-only, IP-bound, withdrawal-disabled key held in an environment
variable, never committed and never sent to a browser.
