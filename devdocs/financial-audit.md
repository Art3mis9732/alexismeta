# Paper-engine financial audit (third prompt §3–§4) — 2026-11-16

Scope: the paper engine as it stood at `bb5ff34` (paper-v1), audited against the conventions in prompt 3 §4, then
corrected in `c06e255` (paper-v2 + `server/accounting.js`, valuation-v1). Classes: **DEFECT** (wrong), **MISSING**
(not built), **LIMITED EVIDENCE** (built, thinly verified), **SIMPLIFICATION** (deliberate modelling choice).

| Area | Finding at paper-v1 | Class | Status now | Evidence |
|---|---|---|---|---|
| Quantities / multipliers | Quantity treated as base units with multiplier 1; no rejection of other contract types | MISSING | `baseUnits()` converts contracts × multiplier and **rejects** non-linear / non-USDT contracts | accounting tests (multiplier 0.001; inverse rejected) |
| Fills | No fill records: entry and exit were fields on the position row | DEFECT | `paper_fills` (unique `fill_id`); every position is rebuilt from its fills | "every position traces to fills" |
| Partial fills / multiple entries | Not representable | MISSING in the engine; **supported and tested in the accounting** | Engine still fills and exits in one piece (v1 policies have one entry and one exit) | partial-exit and multi-fill fixtures |
| Average cost | Single entry price | SIMPLIFICATION → generalised | quantity-weighted average on entries; exits realise against it | fixture: 0.01@100000 + 0.03@100400 → 100300 |
| Entry / exit fees | Both booked only at close, so cash was overstated while open | DEFECT | Entry fee leaves cash at entry; exit fee at exit; pro-rata allocation for partial exits sums to fees paid | cash test; partial-exit fixture |
| Funding sign / timing | Sign correct (long pays positive); priced at **last trade**, no posting record, cursor-only duplicate guard, booked at close | DEFECT | One posting per (position, settlement) with a unique key; priced at the **mark**; booked when it settles | funding fixtures; "cannot be posted twice (restart)" |
| Unrealised P&L | Used the **last trade** price | DEFECT | `U_mark = s·q·(m − e)` from the exchange mark price, with its own timestamp and stale flag | hand fixtures; monitor test |
| Close-now estimate | Absent | MISSING | Depth-weighted walk of the bid (long) / ask (short) side; partial-liquidity and unavailable states; no double-counted slippage | depth-walk fixtures |
| Realised P&L | Correct arithmetic, single number at close | LIMITED EVIDENCE | Re-derived from fills in tests and by `reconcile()` every minute | reconcile test |
| Margin | Not modelled beyond the 2× notional cap | MISSING | Simulator convention: reserved = entry notional / leverage setting (2×). **Not** a Bitget margin statement; no tiered maintenance margin | account fixture |
| Equity / available | "Equity" = realised only | DEFECT | cash, mark equity, reserved margin, available balance defined and tested | account fixture |
| Drawdown | Peak updated only on realised closes | DEFECT | Peak tracks mark equity every tick | engine `rollDay()` |
| Portfolio separation | Three independent 1,000 USDT portfolios; no shared allocator | OK | Shown side by side, never summed; within one analyst the correlated-bucket limits are enforced in one transaction | isolated-portfolios test |
| Open-risk measure | Counted entry slippage twice (about +0.4%) | DEFECT (conservative) | Fixed in `risk.openRisk` | found by the shared-limit test |
| Atomicity | Position, portfolio and ledger written separately | DEFECT | One transaction per state change (fact + projection + ledger + outbox event) | engine code; reconcile test |
| Gap handling | Assessed only at close; position looked normal while open | DEFECT | Flagged while open (`gap_affected`, "unresolved path"), stays open and fully accounted; exits only at observed prices; counted as uncertain | gap-policy test (D-016) |
| Restart / dedupe | Deterministic decision ids | OK | Plus unique fill and funding keys and a single-writer lock | restart tests; e2e restart |
| Liquidation | 2× setting keeps liquidation far away; not simulated | SIMPLIFICATION | Unchanged; the risk gate requires liquidation ≥ 2× stop distance | sizing fixtures |
| Latency | Decision → fill assumed instantaneous at the decision-time quote + 2 bps | SIMPLIFICATION | Unchanged; disclosed in every fill's `model` | – |

## Conventions (canonical, tested): see the header of `server/accounting.js`
`U_mark`, remaining close contribution, lifecycle-if-closed-now, cash balance, mark equity, reserved margin, available
balance, and three percentages that each name their denominator. Leverage never multiplies P&L. Precision: quantities are
exact 1e-8 units; money is IEEE double with 1e-9 test tolerance, rounded only for display.

## Data-gap accounting policy (D-016, predeclared)
Position/accounting state, data completeness and metric eligibility are three separate things:
1. **Accounting** always contains every fill, fee and funding posting. A gap never deletes, re-prices or resets anything.
2. **Completeness**: a trade-feed gap or unhealthy feed while a position is open sets `gap_affected` ("unresolved path":
   a stop or target may have traded unseen). Management continues on the resumed tape.
3. **Fills** happen only at observed prices: a stop is filled at the worse of the stop and the first observed crossing
   trade, never at the requested stop price by assumption.
4. **Metrics**: the outcome is excluded from path-dependent metrics (wins, expectancy) and reported in the uncertain
   count, share, net result and exposure. Both "all closed" and "evaluable only" results are always shown.
Not implemented: alternative/stressed scenario branches for a gap-affected position, and quarantining a whole portfolio
when uncertainty is large. With three trades in a portfolio this would be a judgement call; it is listed as missing scope.
