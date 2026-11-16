# Defect inventory — session 3 start (2026-11-16 12:20 UTC) and what happened to each

Classes: VERIFIED · IMPLEMENTED_UNVERIFIED · PARTIAL · BROKEN · MISSING · EXPERIMENTAL · NO_DEMONSTRATED_BENEFIT.

| # | Item | Class at start | Now | Evidence |
|---|---|---|---|---|
| 1 | Workers on 8787/8791 | not running (cloud session restarted) | restarted; identities checked against the tree fingerprint | /api/runtime |
| 2 | Forward and TEST databases separate | VERIFIED | VERIFIED (different `db_id`, TEST `positions=16`, forward only natural ones) | e2e step 0 |
| 3 | News display empty/incomplete | BROKEN (2 defects + 1 limitation) | repaired, see news-diagnosis.md | V-025, V-026 |
| 4 | News: only 2 sources, no interpretation, no dedupe across feeds, link check accepted any .com/.org/.gov host | MISSING/PARTIAL | 7 sources, canonical-URL dedupe, per-source host allowlists, rule interpretation, reaction since discovery | V-026 |
| 5 | Paper accounting, TEST separation | VERIFIED | still VERIFIED (146 → 148 tests, e2e 31 + 23) | V-026 |
| 6 | "36 abstentions, no natural forward trade" | stale | **superseded**: 54 decisions; first natural entries at 12:30 UTC (5 shorts) | V-027 |
| 7 | Reported adverse history "is the Balanced rule" | UNVERIFIED claim | PARTIAL: the 180-day test (`stats.json`) covers the LEGACY Neutral profile (entry rule + 0.5-ATR minimum stop + 1.5R + 8 h time exit + legacy costs). Balanced v1 shares the trigger rule and the 1h-trend/VWAP gate but adds data/coverage gates, spread and depth checks, risk-sized quantities and different costs, so it is **related, not identical**. No exact v1 backtest exists. The adverse result stays visible | news milestone did not change this; milestone D |
| 8 | Fable Advisor inside the website | does not exist | unchanged: naming mismatch documented (user confirmed it is the Claude Code dev reviewer) | tab-inventory.md |
| 9 | Node versions | tested only on 22.23.4 on Linux; user reports Node v26.13.0 / npm 12.2.2 on Windows | the user's report is not my verification; `node:sqlite` and the built-in WebSocket are the version-sensitive parts | runbook |
| 10 | Restarting the forward worker marks open positions as gap-affected | undocumented operational hazard | demonstrated live (V-027); rule recorded: do not restart the forward worker with open positions | D-022 |
| 11 | Stress detection, historical evaluation, jobs/model lab, GA/RL | MISSING | still MISSING (milestones C-stress, D–G) | requirements.md |
