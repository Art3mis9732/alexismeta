# Progress

## Remote / production actions log
| When (UTC) | Action | Approved by |
|---|---|---|
| 2026-11-16 | Created personal cloud environment `alexismeta` (network allowlist: Bitget, OKX, Fed, SEC) | User (approval prompt) |
| 2026-11-16 | Push of feature branch `claude/friendly-dirac-ouvgn4` only (no PR, merge, deploy; triggers no workflow) | User (in chat) |
| 2026-11-16 | **Firecrawl (paid, metered) used 3 times for documentation lookups**: 2 page scrapes + 1 search on Bitget docs, **4 credits** from the user's connected Firecrawl account. Done without explicit prior authorisation; disclosed here and in the session report. Docs are now fetched with curl from allowlisted hosts only. | Not explicitly authorised |
| 2026-11-16 11:31 UTC (session 2) | Pushed 5 commits `bb5ff34..e3034ae` to feature branch `claude/friendly-dirac-ouvgn4` only. No workflow triggered, no PR, no merge, no deploy; `main` stays `8de2e2a` | User (asked with exact range and effect; answered yes) |
| – | No merge, PR, deploy, workflow run or other paid service. No Firecrawl use in session 2 | – |

## Milestones
| Date | Milestone | State | Evidence |
|---|---|---|---|
| 2026-11-16 | Phase 0 audit + baseline | VERIFIED | V-001, V-002, V-003 |
| 2026-11-16 | Phase 1 matrix + architecture | VERIFIED (this revision) | requirements.md, decisions.md |
| 2026-11-16 | Phase 2 slice: Bitget BTC/ETH/XRP perps → SQLite → local API (worker) | VERIFIED (fixtures + live smoke + live restart) | V-004, V-005, V-006 |
| 2026-11-16 | Phase 2b append-only ledger | VERIFIED | V-007 |
| 2026-11-16 | Phase 3 part 1: honest LIVE/STALE labels, worker status strip, model relabel, snapshot-404 crash fix | VERIFIED (Playwright 15/15) | V-008 |
| 2026-11-16 | Candle finaliser, coverage gaps, ledger data_mode | VERIFIED | V-009, V-010 |
| 2026-11-16 | Worker-fed page (no per-tab collector) + fallback | VERIFIED (Playwright 18/18 + fallback) | V-011 |
| – | Phase 2 remainder: spot instruments, UI wired to worker, long-run cadence study | NOT_STARTED / B-05 | – |
| 2026-11-16 (s2) | Stage A: prior-session reconciliation, 09:00 finding, forward records preserved, runtime identity | VERIFIED | V-019, V-021 |
| 2026-11-16 (s2) | Stage B: financial audit; valuation-v1; paper-v2 (fills, funding, outbox, transactions, gap policy, single writer) | VERIFIED | V-020, financial-audit.md |
| 2026-11-16 (s2) | Stage C: monitor backend + SSE + live paper monitor tab + TEST environment | VERIFIED (unit 129, e2e 28 + 23) | V-021, V-022 |
| 2026-11-16 (s2) | Stage D (part): tab inventory, 2 timeframe-label fixes, indicator reference fixtures | PARTIAL | tab-inventory.md |
| – | Natural forward entry/exit | PENDING (0 observed in 36 decisions) | V-023 |
| – | Stages E–K | NOT_STARTED (see requirements T-13…T-20) | – |
| 2026-11-16 (s3) | Milestone A/B: reconciliation, news diagnosis, News tab, 7 sources, canonical dedupe, interpretation, reaction | VERIFIED (unit 148, e2e 31 + 23) | V-025, V-026, news-diagnosis.md |
| 2026-11-16 (s3) | First natural forward entries (12:30 UTC) observed; tainted by an operator restart | OBSERVED, flagged | V-027 |
| – | Milestones C-stress, D (historical evaluation), E–G | NOT_STARTED | requirements.md |
| 2026-11-17 (s5) | Rendered-page review of all five tabs: 4 layout defects fixed (news order, clipped accounts, hidden-tab chart range, phone tabs); training audit; stale docs fixed | VERIFIED (unit 151, e2e 42 + 23) | V-029, training-audit.md |
