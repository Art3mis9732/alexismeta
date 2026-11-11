# alexismeta — Bitget edge dashboard

A public dashboard for BTC/ETH/XRP USDT-margined perpetuals on Bitget, plus the research lab
(`bgbot/`) that tests whether a simple strategy has an edge after fees, funding, slippage and leverage.

**No API keys, no account access, no orders.** Everything on the site is public market data.

## What's here
| Path | What it does |
|---|---|
| `docs/index.html` | The website (GitHub Pages): price, mark/index, spread, funding, OI, contract specs, 30-day charts, links to free analysis sites |
| `docs/data/latest.json` | Data the site reads; rewritten hourly by the snapshot workflow |
| `scripts/fetch_snapshot.py` | Pulls public Bitget data and writes `latest.json` |
| `.github/workflows/snapshot.yml` | Runs the fetch every hour at :17 (UTC) and commits the result |
| `.github/workflows/tests.yml` | Runs the 22 lab tests on every push |
| `bgbot/`, `tests/`, `config/` | The research lab (see `LAB.md`) |

## Turn the website on (one time)
1. Repo **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/docs` → Save.
2. Repo **Actions** tab → enable workflows if asked → **market-snapshot → Run workflow**.
3. Open `https://art3mis9732.github.io/alexismeta/` after ~1 minute.

If the snapshot job logs an error, Bitget may be refusing requests from GitHub's (US-based)
servers. The site then shows a banner; the "Try live prices from my browser" button and running
`python scripts/fetch_snapshot.py` on your own PC are the fallbacks.

## Why the account isn't connected
A public static site cannot keep a secret. Account tools (balances, positions, demo orders) will run
locally from `bgbot/` with a read-only, IP-bound, withdrawal-disabled key held in an environment
variable — never committed and never sent to a browser.
