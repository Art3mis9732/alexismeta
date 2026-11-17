# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`; pull request [#1](https://github.com/Art3mis9732/alexismeta/pull/1) (base `main`). Remote head and the commit CI last tested: `76c066e`
(check `tests` success). **Local commits after `76c066e` are NOT pushed and remote CI has not tested them**: the stress milestone (`5ac93e8` and the commit after it).
A push needs its own approval; pushing updates PR #1. `main` is `8de2e2a`, untouched; merging to `main` publishes the site and needs explicit approval.

## Reconciliation at the start of session 6 (evidence in V-030)
| Item | State |
|---|---|
| Source | local = remote = `76c066e`, clean; PR #1 open, mergeable clean |
| CI | `tests` success on `76c066e` only |
| Workers | none were running (container reset); restarted 09:25 UTC |
| Served UI | `955a4a5` markers present in served files (frontend is read from disk, no-store) |
| Forward DB | schema v8, ledger chain ok, downtime gap recorded once |
| Earlier stale instruction | the "ask to push" step is obsolete (done); removed below |

## State at the end of session 6
* **Tests (local):** `npm test` 186/186, pytest 22/22, `monitor.e2e.js` 55/55 on the TEST worker (forward-only checks skipped: forward build older), `status.e2e.js` 23/23 earlier in the session (not rerun on the final tree).
* **Market-stress milestone (stress-v1, stress-policy-v1) is implemented and verified on TEST and on a copy of the forward DB; PROVISIONAL, SHADOW.** See `stress-design.md`, `stress-calibration.md`, V-031, D-024..D-028.
* **Forward worker 8787 is still on `76c066e` (schema v8, no stress monitor) and holds TWO OPEN natural positions** (Balanced and Risk Taker ETH shorts, opened 10:00:08 UTC, time exits 18:00 and 14:00 UTC), both flagged `gap_affected` by a real websocket disconnect at 10:01:45. **Do not restart it while they are open** (D-022/D-027).
* **Cloud workers die when a turn ends** (observed twice). Every session starts as a restart after a gap; the stress monitor treats that as an UNOBSERVED gap. No continuous-monitoring claim is made here. A local Windows worker would run continuously.
* TEST worker 8791 runs the stress synthetic scenario (`--env test --fixture --stress-fixture`); static server 8788. A forward backup before v9: `data/backups/market-pre-stress-20261117-093001.db`.
* Training: one fitted model exists (logistic regression per timeframe, display-only, no edge); nothing in the stress module is trained (`training-audit.md`).

## Next exact steps
1. **Ask for approval to push** the local commits (range after `76c066e`); it updates PR #1 and re-runs remote CI. Nothing else is triggered.
2. **Activate the stress monitor on the forward environment** when both ETH positions are closed (check with a read-only SQLite query: `SELECT COUNT(*) FROM paper_positions WHERE state='OPEN'`;
   `node server/admin.js status` refuses a v8 file under v9 code, as designed). Then: (a) `node server/admin.js backup data/backups/market-pre-v9-<time>.db` (works on any schema, read-only on the source; verified this session);
   (b) stop the worker gracefully `pkill -INT -f "main[.]js --port 8787"`; (c) start it on the new build shortly after a 15-minute bar close (it migrates v8 to v9 on open);
   (d) check `/api/runtime` (`stress` block, `build.revision`) and `/api/stress`, then `node server/admin.js verify-ledger` and `status`.
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
