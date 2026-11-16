# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`. Pushing this branch only is approved (no PR, no merge, no deploy).
**State:** see `progress.md` (milestones) and `verification.md` (V-001…). Latest: worker + ledger + risk gate + evidence +
3 v1 policies + paper engine + replay verify + official news. `npm test` 97/97; Playwright 21/21.

## Next exact steps (in order)
1. Capture the live 08:45/09:00 bar-close decisions from the long-running worker (port 8790, scratchpad `long.db`):
   nine decisions per bar, one evidence hash per coin, `verify-ledger` ok, `replay --verify` ok, recomputed
   `candles.rows_hash` equals the stored one.
2. Historical replay of the v1 policies over stored/REST history (assumption-based research: label it so),
   chronological splits, costs, baselines (cash, buy-and-hold, trend). Forward and backtest results kept separate.
3. Phase 7 forecasts: ledgered baselines (random walk, rolling distribution, momentum) with horizon resolution and a
   calibration gate. No probability shown until the gate passes.
4. Phase 3 remainder: timezone selector (default Asia/Kolkata), accessibility pass; spot instruments.
5. Known limits to address: non-atomic open/close writes; `COUNT(*)` per health poll and one-shot prune will slow down
   at millions of rows (see the runbook projection); event-risk restrictions; maintenance tiers > 1.

## Running processes (cloud container only)
* Long-run worker on port 8790 (scratchpad `long.db`). Stop with `pkill -INT -f "main[.]js --port 8790"`.
* Static server on 8788. Stop with `pkill -f "http[.]server 8788"`.

## Environment notes
* Cloud container: Node needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`.
* Tested runtime: Node 22.23.4 (`engines` >= 22.23). Windows startup not executed (B-03).
* Do not use Firecrawl or other metered services without asking; fetch docs with curl from allowlisted hosts.
