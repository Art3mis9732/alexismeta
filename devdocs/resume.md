# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`. Remote is at `fbc2de9` (pushed 2026-11-16 with explicit approval for `0e5ecd4` + `fbc2de9`: News tab,
news-v2, schema v7+v8, tooling guard, docs). Each further push needs its own approval. No PR, merge or deploy; `main` is `8de2e2a`.
**State:** milestones A (reconciliation, UI repair) and B (news diagnosis + News Intelligence) done and verified. `npm test` 151/151,
pytest 22/22, `tests_e2e/monitor.e2e.js` 36/36 (forward + TEST), `tests_e2e/status.e2e.js` 23/23.
Records: `news-diagnosis.md`, `defect-inventory.md`, V-025…V-027, D-020…D-022, requirements P4-01…P4-13.

## Running processes (cloud container only)
* Forward worker 8787: build `0e5ecd4`, schema v8, news-rules-v1.1 (restarted 12:48 UTC when no position was open). All five natural
  positions (12:30 bar) closed by stop as uncertain losses. **If a position is open, do not restart it** (D-022) unless the user accepts a gap.
* TEST worker 8791 (new build), static server 8788. Stop: `pkill -INT -f "main[.]js --port 8791"`, `pkill -f "http[.]server 8788"`.
* Export the forward ledger before ending a session (read-only): `node server/admin.js export-evidence devdocs/evidence/forward-ledger-2026-11-16.json` (last: 83 ledger rows).

## Next exact steps
1. Ask for approval to push the local commits (exact range after `ae70a94`; it triggers nothing). Windows will not see this work until then.
2. Milestone C: market-stress module (versioned, hysteresis, separates data-quality failure from market stress, risk response that
   suspends new entries but never disables accounting). Predicate-level abstention view already exists.
3. Milestone D: availability matrix for every feature; exact replay of recorded windows; a separately versioned candle-only baseline;
   reproduce the legacy 180-day result (it covers legacy Neutral, not Balanced v1).
4. More news sources need host approval (ECB, CFTC, BLS, Ethereum/Ripple channels): one `update_environment` proposal with exact hosts.
5. Narrow the Fed-speech rule (news-rules-v1.2); evaluate news interpretation by ablation before any decision use.
6. Later: research registry + real job runner before any training UI; evaluation of news interpretation by ablation.

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`. Tested runtime: Node 22.23.4 on Linux.
* User's Windows: Node v26.13.0 / npm 12.2.2 reported working; not verified by me. The cloud ledger is not the Windows ledger.
* Do not use Firecrawl or other metered services without asking. SEC rate-limits bursts: never probe sec.gov repeatedly.
