# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`. Remote is at `ae70a94`. Session 3 work (news-v2, News tab, schema v7+v8, docs) is
committed locally only and needs the user's approval before any push. No PR, merge or deploy.
**State:** milestones A (reconciliation, UI repair) and B (news diagnosis + News Intelligence) done and verified. `npm test` 148/148,
pytest 22/22, `tests_e2e/monitor.e2e.js` 31/31 (forward-only checks skipped, see D-022), `tests_e2e/status.e2e.js` 23/23.
Records: `news-diagnosis.md`, `defect-inventory.md`, V-025…V-027, D-020…D-022, requirements P4-01…P4-13.

## Running processes (cloud container only)
* Forward worker 8787: build `c58d076` (news-v2.0, schema v7). **Has 3 open paper positions (BTC shorts, gap-flagged). Do not restart it
  until they close** (Risk Taker time exit about 16:30 UTC, Balanced/Defensive about 20:30 UTC) unless the user accepts a gap.
  When restarted it applies schema v8 and news-rules-v1.1 (verified on a copy).
* TEST worker 8791 (new build), static server 8788. Stop: `pkill -INT -f "main[.]js --port 8791"`, `pkill -f "http[.]server 8788"`.
* Export the forward ledger again before ending a session: `devdocs/evidence/forward-ledger-2026-11-16.json` (last: 68 ledger rows).

## Next exact steps
1. Ask for approval to push the local commits (state the exact range and that it triggers nothing).
2. Milestone C: market-stress module (versioned, hysteresis, separates data-quality failure from market stress, risk response that
   suspends new entries but never disables accounting). Predicate-level abstention view already exists.
3. Milestone D: availability matrix for every feature; exact replay of recorded windows; a separately versioned candle-only baseline;
   reproduce the legacy 180-day result (it covers legacy Neutral, not Balanced v1).
4. More news sources need host approval (ECB, CFTC, BLS, Ethereum/Ripple channels): one `update_environment` proposal with exact hosts.
5. Later: research registry + real job runner before any training UI; evaluation of news interpretation by ablation.

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`. Tested runtime: Node 22.23.4 on Linux.
* User's Windows: Node v26.13.0 / npm 12.2.2 reported working; not verified by me. The cloud ledger is not the Windows ledger.
* Do not use Firecrawl or other metered services without asking. SEC rate-limits bursts: never probe sec.gov repeatedly.
