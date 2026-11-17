# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`; pull request [#1](https://github.com/Art3mis9732/alexismeta/pull/1) (base `main`). Remote head and the last CI-tested commit: `2297983` (check `tests` success).
**Local commits NOT pushed:** `7470354` (live Open positions panel + accounting extras), `1d45271` (recorded timeline/drawdown, schema v10), `5014e62` (history filters, legacy relabel/replay) and the documentation commit after them. Remote CI has not tested them.
A push needs its own approval. `main` is `8de2e2a` and untouched; merging to `main` publishes the site and needs explicit approval.

## State at the end of session 6 (second half: live accounting milestone)
* Tests (local): `npm test` 208/208, pytest 22/22, `monitor.e2e.js` 79/79 (forward + TEST, clean build), `status.e2e.js` 23/23.
* **Forward worker 8787 is running build `5014e62`, schema v10, stress monitor in SHADOW, valuation recorder on, 0 open positions** (started 11:10:59 UTC after the cloud worker died; D-029). It will die again when the session ends; the next session starts as a restart after a gap.
* The three forward shorts opened 11:00 UTC closed at 11:11:05 by stops at first observed prices (uncertain, net -2.57, -5.16, -3.37 USDT). Earlier natural ETH shorts closed at targets (+2.04, +5.87, uncertain). All hand-checked. No edge is demonstrated.
* Pictured legacy trade: by the producer's rule stopped at 09:00 UTC (about -0.98 USDT); the published journal will show it only after the producer's next run (runs are 4-9 h apart).
* Backups: `data/backups/market-pre-stress-*`, `market-pre-live-accounting-*`, `market-pre-v10-*` (all schema v8).
* Records: `accounting-contract.md` (field dictionary), `live-accounting-milestone.md` (screenshot trace, phases, incident, limitations, rollback), V-032, V-033, D-029..D-032, P7-xx, defects 28-32.

## Next exact steps
1. **Ask for approval to push** the local commits (range after `2297983`); it updates PR #1 and re-runs remote CI. Nothing else is triggered.
2. (Done in session 6, D-029) The stress monitor and the v9/v10 migrations are active on the forward environment. Keep observing; do not restart the forward worker while it holds an open position unless it is already down.
3. Observe SHADOW: how often would it have blocked, what happened to those entries. Only then ask the user whether to ENFORCE (`--stress-mode enforce`; D-024).
4. Milestone D: historical evaluation of the three analysts (reproduce the adverse legacy result; stress-gated vs ungated, same costs); availability matrix; candle-only baseline. Then training foundations (`training-audit.md`).
5. More news sources need host approval (`news-source-candidates.md`, nothing contacted). Narrow the Fed-speech rule (news-rules-v1.2).
6. Liquidity baseline: a few hours of forward samples are needed before spread/depth contribute; consider a per-instrument evaluation after a week of samples.

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`; pytest/numpy/pandas must be pip-installed after a container reset. Node 22.23.4 on Linux.
* `scripts/stress_fetch_1m.js` downloads 90 days of public 1m candles (about 15 minutes for three instruments, free) into gitignored `data/hist/`; `scripts/stress_calibrate.js` runs in about 12 s.
* User's Windows: Node v26.13.0 / npm 12.2.2 reported working; not verified by me. The cloud ledger is not the Windows ledger. A Windows path (`C:\Users\ASUS\Projects\crypto-monitor-local`) came from an external analysis: unverified.
* Visual verification = Playwright screenshots read by me. Claude Code Desktop preview and Claude in Chrome were NOT used.
* Do not use Firecrawl or other metered services without asking. SEC rate-limits bursts.
