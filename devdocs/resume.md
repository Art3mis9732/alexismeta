# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`; pull request [#1](https://github.com/Art3mis9732/alexismeta/pull/1) (base `main`, CI `tests` green on
`8102e31`). Remote head is `8102e31`; session-5 work is in **local commits not yet pushed** (a push needs its own approval; pushing
updates the PR). `main` is `8de2e2a` and is untouched; merging to `main` publishes the site, so it needs explicit approval.
**State:** milestones A (reconciliation), B (news) done; session 5 did a rendered-page review of every tab and fixed four layout defects
(V-029). `npm test` 151/151, pytest 22/22, `monitor.e2e.js` 42/42 (forward + TEST), `status.e2e.js` 23/23.
**Training:** one fitted model exists (logistic regression per timeframe, daily refit in GitHub Actions, display-only, no edge); everything
else is deterministic. See `training-audit.md`.

## Running processes (cloud container only)
* Forward worker 8787 and TEST worker 8791 on the committed session-5 build; static server 8788. The container restarts between sessions;
  the forward DB (`data/worker/market.db`) survived once, so check `node server/admin.js status` before starting anything.
  Start: `NODE_USE_ENV_PROXY=1 node server/main.js --port 8787` and `... --port 8791 --env test --fixture`.
* **If a position is open, do not restart the forward worker** (D-022) unless the user accepts a gap. Restart just after a 15-minute bar close.
* Export the forward ledger before ending a session (read-only): `node server/admin.js export-evidence devdocs/evidence/forward-ledger-<date>.json`.

## Next exact steps
1. Ask for approval to push the local commits (range after `8102e31`); it updates PR #1 and triggers CI only.
2. Milestone C-stress: market-stress module (versioned, hysteresis, severity separate from data quality, risk response that blocks new entries
   but never disables accounting; shadow/TEST first).
3. Milestone D: availability matrix; exact replay of recorded windows; reproduce the legacy 180-day result (it covers legacy Neutral, not Balanced v1).
4. More news sources need host approval: see `news-source-candidates.md` (nothing contacted).
5. Narrow the Fed-speech rule (news-rules-v1.2); evaluate news interpretation by ablation before any decision use.
6. Training foundation only after D: manifests, purged walk-forward, registry, job runner (`training-audit.md`).

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`; pytest/numpy/pandas must be pip-installed
  after a container reset. Tested runtime: Node 22.23.4 on Linux.
* User's Windows: Node v26.13.0 / npm 12.2.2 reported working; not verified by me. The cloud ledger is not the Windows ledger.
  A Windows path was supplied by an external analysis (`C:\Users\ASUS\Projects\crypto-monitor-local`); unverified.
* Visual verification here = Playwright screenshots read by me. Claude Code Desktop preview and Claude in Chrome were NOT used or verified.
* Do not use Firecrawl or other metered services without asking. SEC rate-limits bursts: never probe sec.gov repeatedly.
