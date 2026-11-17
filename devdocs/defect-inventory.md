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
| 12 | Fed speeches: every speech is scoped MACRO and gets "forward guidance can shift rate expectations", including AI and inequality talks; about half of the 31 "relevant" items are speeches | BROKEN (rule overreach, same class as the tokenized bug) | logged; narrow in news-rules-v1.2 (require monetary/economic-policy wording) | V-026 |
| 13 | `admin.js`/`replay.js` migrated the live DB (schema v8) while a worker ran | BROKEN (tooling) | fixed: read-only connections + schema guard, tested | V-028 |
| 14 | News back-off was in memory only | PARTIAL | fixed: restored from the fetch log after a restart, tested | V-028 |
| 15 | Windows restore instructions ignored a leftover `-wal`/`-shm` file | BROKEN (docs) | fixed in the runbook; no restore drill has been run | runbook |
| 11 | Stress detection, historical evaluation, jobs/model lab, GA/RL | MISSING | still MISSING (milestones C-stress, D–G) | requirements.md |
| 16 | News tab: articles sat below a full-screen source-health table (first screen showed no news) | BROKEN (UX) | fixed: items first, collapsible health with verdict, browser-checked | V-029 |
| 17 | Paper monitor: third account column clipped at 1440 px | BROKEN (layout) | fixed (`minmax(0,1fr)`), forward-page check, mutation-verified | V-029 |
| 18 | Patterns chart drawn while hidden: candles squeezed to one side, labels unreadable (visible range 2083 bars) | BROKEN | fixed (`refitCharts()` after tab switch), check mutation-verified | V-029 |
| 19 | Phone: tab bar clipped "Indicators" | BROKEN (layout) | fixed, checked | V-029 |
| 20 | Legacy Patterns chart: pattern labels still overlap in dense regions | PARTIAL | open (cosmetic; markers are legacy) | V-029 |
| 21 | Earlier summaries and an external analysis said the project has no trained model; a logistic regression per timeframe is trained daily (display-only, no edge) | DOC ERROR | corrected in `training-audit.md` | training-audit.md |
| 22 | External prompt listed tabs "Dashboard, Settings, Fable Advisor, Model Lab"; the page has only five tabs (Paper monitor, News, Buy/Sell, Patterns, Indicators) | NOT A DEFECT (nonexistent) | recorded; nothing invented | tab-inventory.md |
| 23 | `deployment-runbook.md` said the news milestone was not pushed | DOC STALE | fixed | runbook |
| 24 | Natural forward positions (ETH shorts 10:00:08 UTC) were flagged "outcome not evaluable" by a 1.8 s real websocket disconnect; websocket drops recur every ~10-13 min today | OBSERVED (data-feed property, D-016 working as designed) | recorded; cause of the drops unknown; whether container CPU load contributed is unknown | V-031 |
| 25 | Forward worker runs the pre-stress build (schema v8) and has no stress monitor | PENDING (D-027) | migration validated on a copy; applies at next restart with no open position | V-031 |
| 26 | Stress detector reacts to moves rather than anticipating them; XRP shows no lift; severity levels not monotonic; liquidity families uncalibrated | LIMITATION (documented, not a bug) | provisional; shadow-only | stress-calibration.md |
| 27 | Cloud workers die when a turn ends (observed twice at 08:56 UTC and between sessions); every session starts as a restart after a gap | LIMITATION | monitor treats the gap as UNOBSERVED; no continuous-monitoring claim is made; a Windows worker would run continuously | resume.md |


| 28 | Legacy panel claimed "runs every 15 minutes ... even when this page is closed"; actual runs are 4-9 h apart; open trade shown as open although its stop was reached | BROKEN (claim) | relabelled, cadence and last run shown, open trades replayed on final candles | V-032 |
| 29 | Legacy amounts shown with "$" as if USD | MISLEADING | shown as USDT, hypothetical | live-accounting-milestone.md |
| 30 | Browser applied valuation frames with no ordering check (old frame could roll back or resurrect a closed position) | BROKEN (robustness) | old-frame rejection and tombstones, tested | V-033 |
| 31 | Open-positions table below the fold, clipped, no per-position mark/freshness | BROKEN (UX) | new panel above accounts | V-033 |
| 32 | Cloud worker death left 3 natural positions unmanaged and uncertain | LIMITATION (environment) | recorded; gap policy applied; continuous monitoring not claimed | live-accounting-milestone.md |
