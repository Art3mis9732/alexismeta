# Repository audit (Phase 0)

Audited 2026-11-16 by Claude Code in a cloud container (Linux, Node 22.23.4, Python 3.13.18).
Starting point: branch `claude/friendly-dirac-ouvgn4` = `main` = `8de2e2a`, working tree clean, no stashes,
no untracked files. Nothing was reset, stashed or deleted.

> **Why `devdocs/` and not `docs/`:** `docs/` is the GitHub Pages site root. `scripts/publish.sh` copies all of
> `docs/` to `gh-pages`, so any audit file placed there would be published on the next run. Engineering records
> live in `devdocs/` instead (decision D-001).

## 1. What the project is

| Part | Technology | Role | Runs where |
|---|---|---|---|
| `docs/index.html` (821 lines) | Vanilla JS, no build step, TradingView Lightweight Charts (vendored, Apache-2.0) | The public website: Buy/Sell, Patterns and Indicators views | The browser, served from the `gh-pages` branch |
| `docs/patterns.js` (475 lines) | UMD JS, used by both the browser and Node | Pattern engine, indicators, three trader profiles, logistic-model features and prediction | Browser + Node scripts |
| `scripts/fetch_market.py` | Python + requests | Public Bitget REST snapshot written to `docs/data/market.json` | GitHub Actions, every 15 min |
| `scripts/analyze.js` | Node | Current read per coin written to `read.json` | GitHub Actions |
| `scripts/paper_trader.js` | Node | Forward paper journal written to `journal.json` (candle-based) | GitHub Actions, every 15 min |
| `scripts/fetch_history.py`, `pattern_stats.js`, `train_model.js` | Python + Node | 180-day history, then pattern statistics (`stats.json`) and a logistic model (`model.json`) | GitHub Actions, daily |
| `bgbot/` + `config/default.toml` | Python (pandas, numpy) | Research lab: 4H backtester, sizing, metrics, dev/lock/holdout experiment, OMS safety layer with a fake exchange | Local only |
| `.github/workflows/` | GitHub Actions | `snapshot.yml` runs every 15 min **and on push to `main`**; `stats.yml` runs daily; `tests.yml` runs on push to `main` and on PRs | GitHub |

**Hosting:** a static site on GitHub Pages (`https://art3mis9732.github.io/alexismeta/`) served from `gh-pages`.
`scripts/publish.sh` **force-pushes** a fresh single-commit `gh-pages` on every run, so only the latest state
exists there. There is **no persistent backend, no database and no long-running process**. "Continuous" today
means two things: the browser's own WebSocket while a tab is open, and a 15-minute cron that GitHub may delay.

**Deployment triggers (verified from the workflow files; remote Pages settings not inspected):**

* A push to `main` that touches `docs/**`, `scripts/**`, `bgbot/**` or `snapshot.yml` publishes the site immediately.
* A push to any `claude/*` branch triggers **no** workflow. Opening a PR triggers `tests.yml` only.
* Unknown: the Pages source setting (assumed `gh-pages` because the README says so), branch protection, and the
  repository secrets beyond `GITHUB_TOKEN`.

## 2. Baseline checks (before any edit)

| Check | Command | Result |
|---|---|---|
| Node engine tests | `node --test tests_js/patterns.test.js` | **23/23 pass** (the README says 14, so it is out of date) |
| Python lab tests | `.venv/bin/python -m pytest -q` | **22/22 pass** on Python 3.13 / pandas 3.1.1 / numpy 2.5.5. CI pins Python 3.11 |
| pytest | system Python | not installed system-wide, so a project `.venv` was created (git-ignored) |
| Bitget REST from the container | `curl https://api.bitget.com/api/v2/public/time` | blocked (proxy 403) under the Default environment. After the user approved the `alexismeta` environment: **200, code 00000** |
| Node `fetch` / `WebSocket` via the proxy | `NODE_USE_ENV_PROXY=1 node -e ...` | both work. Plain `fetch` without the flag fails (ENOTFOUND). This is specific to the cloud container: a home Windows PC needs no proxy |
| `node:sqlite` | `require("node:sqlite")` | available in Node 22.23 (experimental warning) |

## 3. Data sources found in the code

| Source | Where | Real or simulated | Notes |
|---|---|---|---|
| Bitget REST v2 mix `tickers`, `contracts`, `history-candles`, `query-position-lever`, `account-long-short`, `taker-buy-sell` | `bgbot/bitget_public.py`, `scripts/fetch_market.py` | Real, public | Classic v2 schema, used consistently. Missing funding and OI become `0` (DEFECT A-03) |
| Bitget REST v2 `candles` | `docs/index.html` `fetchRest` | Real, from the browser | |
| Bitget WS v2 public `candle5m/15m/4H`, `ticker` | `docs/index.html` `connectStream` | Real, from the browser | Only while a tab is open |
| `bgbot/synthetic.py` | lab tests only | **Synthetic** | Plumbing tests only, never shown on the site. Correctly labelled |
| `Math.random` | nowhere in the site or engine | | No random or placeholder market values were found |

## 4. The "three trading personalities" as they exist today

| Prompt name | Existing profile | Timeframe | Rule | Default leverage |
|---|---|---|---|---|
| Risk Taker | `aggressive` | 5m | False breakout of the first 4h UTC range, 2R target | 50x on $5 margin |
| Balanced Trader | `neutral` | 15m | 1h EMA trend + side of VWAP + breakout/retest/VWAP-pullback trigger, 1.5R | 10x |
| Defensive Trader | `careful` | 15m | Neutral subset: retest/VWAP-pullback only, 24h agreement, ATR not in the top quartile, min stop 1 ATR | 3x |

Findings:

* The rules are deterministic and genuinely different. Careful, however, is a strict **subset** of Neutral, and
  Aggressive uses a different timeframe and a different setup family. They do **not** read a shared, versioned
  evidence snapshot.
* Leverage defaults of 50x/10x/3x conflict with the master prompt's 2x simulated ceiling and 1,000 USDT virtual
  equity (DEFECT A-07).
* The rule parameters (`PARAMS`) are frozen in `patterns.js`, and `stats.json`, `model.json` and the forward journal
  are keyed to them. Editing them in place would break the evidence chain (decision D-005).

## 5. "Fable Advisor"

**Not found in the repository.** A case-insensitive search for `fable` and `advisor` across all files matched only
"CFTC advisory" in `docs/SOURCES.md`. The session transcript shows the user ran the Claude Code command
`/advisor fable` ("Advisor set to Fable 5.2"). The most likely reading is that "Fable Advisor" is the Claude Code
development reviewer, not a website component. **This is an inference, unconfirmed by the user** (see `blockers.md` B-02).
It does not block foundation work.

## 6. Defects and misleading behaviour found (pre-existing)

| ID | Where | Defect | Severity | Planned fix (phase) |
|---|---|---|---|---|
| A-01 | `index.html` `setMode` | `● LIVE` is driven by `lastMsg`, which is also refreshed by `"pong"` replies. A connection whose subscriptions stopped, but which still answers pings, shows LIVE | High (honest-status rule) | P3: base freshness on data messages per channel |
| A-02 | `index.html` model card | Headed "Chance the price is higher" and shows a raw logistic output as a percentage. That is an **uncalibrated score**, and the displayed test metrics come from the 70% model while the live model is refit on 100% | High (probability rule) | P7: relabel as "uncalibrated score" now, calibration gate later |
| A-03 | `fetch_market.py` | `float(t.get("fundingRate") or 0)`, `holdingAmount or 0`: missing becomes zero | Medium | P2: worker stores NULL plus a quality flag; the legacy script is patched later |
| A-04 | `paper_trader.js` | The journal is rewritten in place (status changes overwrite the entry) and lives only on force-pushed `gh-pages` | High (append-only rule) | P2: append-only ledger in the worker; the legacy journal is kept and labelled legacy |
| A-05 | `index.html` browser paper trades | Fill exactly at the stop or target on last price; no gap, slippage or funding; stored in `localStorage` | Medium | P8/P9 |
| A-06 | `index.html` `tradePlan` | "BUY"/"SELL" in large type with a "Start paper trade" button and up to 100x leverage. No portfolio risk gate, no stale-data gate | High | P5/P8: risk engine plus NO_TRADE reasons |
| A-07 | `patterns.js PROFILES` | 50x/10x/3x on $5 vs 2x ceiling / 1,000 USDT | Medium | P5: new policy versions alongside |
| A-08 | `README.md` | States 14 engine tests; there are 23 | Low | Doc fix |
| A-09 | `fetch_market.py` | Ticker `ts` stored, but no receipt time, no sequence, no schema version | Medium | P2 worker schema |
| A-10 | `index.html` | Timezone fixed to IST in labels; no selector | Low | P3 |
| A-11 | `taker-buy-sell` / trade `side` | Used as buy/sell pressure. Official classic docs (accessed 2026-11-16) do not define whether `side` is the taker side; only third-party wire-format docs say so | Medium | P4: label "aggressor semantics unverified" until confirmed |

## 7. Security

* No secrets in the repository (`git grep -i "apikey\|secret\|passphrase"` finds only safety notes). `.gitignore`
  excludes `*.env`, `.env*` and `secrets*`.
* `oms.live_allowed` hard-disables live trading in the lab. There is **no order-placement code** against the real
  exchange.
* The browser calls Bitget public endpoints directly, which needs no credentials.
* GitHub Actions uses only `GITHUB_TOKEN` with `contents: write` (needed for the `gh-pages` push).
* Risk: `publish.sh` force-pushes `gh-pages`, so published history (including the forward journal) is not
  retained. That is why a copy was saved to `devdocs/evidence/gh-pages-journal-2026-11-16.json`.

## 8. Uptime constraints (factual)

* GitHub Actions cron: best-effort, often delayed by several minutes, and it can be skipped. It is not continuous.
* Browser stream: only while a tab is open and the machine is awake.
* The new local worker (Phase 2) runs only while the machine is powered, awake and online. A sleeping laptop
  produces gaps, which the worker records as gaps; it does not fill them.
* This cloud container is ephemeral and is not a hosting platform. No deployment was made.
