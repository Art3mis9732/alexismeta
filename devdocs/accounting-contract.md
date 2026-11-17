# Paper accounting contract and field dictionary (valuation-v1 + live-metrics-v1)

Code: `server/accounting.js` (pure functions), `server/monitor.js` (views), `server/valuation_recorder.js` (samples). Tests: `tests_js/accounting.test.js`,
`accounting_live.test.js`, `valuation_recorder.test.js`; browser: `tests_e2e/monitor.e2e.js` section 4e. **Scope: LINEAR USDT-margined perpetuals only**; anything else is rejected.
These are the SIMULATOR's conventions, not a Bitget account statement. Environment is fixed per database (`FORWARD` or `TEST`); every account is `paper:<analyst>` and never summed.

## 1. Symbols and normalisation
* `s` = +1 LONG / −1 SHORT. `Q` = remaining **base-asset** quantity = contracts × contract multiplier, converted **once** in `baseUnits()` (exact 1e-8 units; non-linear or non-USDT contracts are rejected). Tested: 3 contracts × 0.01 = 0.03 BTC, never 3 × 0.01 × 0.01.
* `E` = quantity-weighted average entry **fill** price of the remaining quantity (exits realise against it and leave it unchanged). `M` = exchange **mark** price (own timestamp). `X` = executable close price for the WHOLE remaining quantity from a depth walk of the bid side (long) / ask side (short); if the visible book cannot cover `Q` the estimate is `PARTIAL_LIQUIDITY` (unavailable), never best-bid-times-size. No slippage is added on top of the walk (it would be counted twice).
* Money is IEEE double with 1e-9 test tolerance, rounded only for display.

## 2. Core identities
```
gross_unrealized (U)           = s · Q · (M − E)                       mark-to-market, no fees, no funding
remaining close contribution   = s · Q · (X − E) − exit_fee_est        exit_fee_est = Q · X · taker (0.06%)
cash balance                   = start + external + realised gross − booked fees + settled funding
                                 (cash INCLUDES collateral reserved for open positions; margin is a reservation, not an expense)
mark equity                    = cash + Σ U
reserved margin                = Σ (remaining entry notional / margin setting)         margin setting = 2× in this engine
available balance              = cash − reserved margin                                (open profit is not spendable)
closeout equity (estimate)     = cash + Σ remaining close contribution                 entry fees and funding are ALREADY in cash: not counted again
whole-trade net if closed now  = realised gross + s·Q·(X−E) − entry fees − exit fees booked − exit_fee_est + settled funding
remaining-leg net if closed    = s·Q·(X−E) − exit_fee_est − (entry fee allocated to the open quantity)
identity (tested, residual 0)  : whole-trade net = remaining-leg net + realised part,  realised part = realised gross − entry fees on the closed share − exit fees booked + settled funding
```
Entry fees are allocated to closed/open parts pro rata by quantity (the parts always sum to the fees paid). Funding cashflow at a settlement = −s · rate · Q · mark (a long pays when the rate is positive); one posting per (position, settlement), unique key. Leverage never multiplies P&L. Position average cost follows the engine's weighted-average method for entries and realises exits against it.

## 3. Margin and leverage: what each number is
| Field | Meaning | Formula | Source |
|---|---|---|---|
| `margin.margin_setting_leverage` | configured simulator setting (2×) | engine config | `RISK_DEFAULTS.exchangeLev` |
| `margin.initial` | initial margin of the FULL entry | `Q_entered · E / setting` | fills |
| `margin.allocated_now` | margin allocated to the REMAINING quantity | `Q_remaining · E / setting` | fills |
| `margin.notional_at_mark_per_allocated_margin` | effective exposure-to-margin now (drifts with price) | `Q · M / allocated_now` | mark |
| `margin.recorded_at_entry` | margin, notional and risk budget the ledger recorded when the entry was approved | `risk:<decision>.size` | ledger (immutable). Computed on the pre-slippage reference price, so it differs from fill-based figures by about the 2 bps entry slippage; never mixed into a ratio unless the ratio says so |
| `notional.entry_full / remaining_at_entry / at_mark` | `Q_entered·E`, `Q·E`, `Q·M` | | fills, mark |
| account `exposure.notional_over_mark_equity` | account-level leverage | `Σ Q·M / mark equity` | |
There is **no margin add/remove operation** in this engine. If one existed it would change only the margin denominators; price P&L would not move (tested as arithmetic).

## 4. ROI definitions (each names its denominator; the primary is marked)
| Key | Label | Numerator ÷ denominator | Partial exits |
|---|---|---|---|
| `gross_return_on_initial_margin` (**primary**) | Gross return on initial margin | U ÷ `margin.initial` | denominator stays the FULL entry margin, so the figure does not jump when part of the position is closed |
| `gross_return_on_current_margin` | Gross return on current allocated margin | U ÷ `margin.allocated_now` | denominator shrinks with the remaining quantity |
| `return_on_entry_notional` | Gross return on remaining entry notional | U ÷ `Q·E` | |
| `net_if_closed_on_initial_margin` | Estimated net (whole trade, if closed now) on initial margin | whole-trade net ÷ `margin.initial` | |
| `risk_budget.gross_unrealized_per_risk_budget` | P&L as a share of the recorded risk budget | U ÷ ledger `risk_usdt` | not an ROI on capital |
| closed trade `net_return_on_initial_margin_pct` | booked net ÷ initial margin | net after all fees and funding ÷ `Q_entered·E/setting` | per trade only |
| account `account_return.value_pct` | Account return | (mark equity − (start + external)) ÷ (start + external) | position ROIs are NEVER averaged into it; no deposits/withdrawals/resets exist in this engine |
A missing, zero or invalid denominator gives `value: null` with a `reason` (`DENOMINATOR_UNAVAILABLE`, `MARK_UNAVAILABLE`, `CLOSE_ESTIMATE_UNAVAILABLE`), never 0% or infinity. Break-even is `0` (a real value), not unavailable.

## 5. Display tolerance and classes
`signClass(v)`: `GAIN` if v ≥ 0.005 USDT, `LOSS` if v ≤ −0.005, `FLAT` between, `UNAVAILABLE` for null. Text keeps its sign (+/−) so the meaning never depends on colour alone; the colour is green/red only outside the tolerance. The tolerance is a display rule only; no formula uses it.

## 6. Freshness (separate for mark and book)
`prices.mark_status` / `book_status` ∈ OK | STALE | UNAVAILABLE (stale threshold 10 s each, the same as the feed-health rule). A stale mark keeps the **last valid** gross P&L, labelled stale with its age; an unavailable mark gives `null`, never 0. A fresh mark with a stale or missing book keeps mark P&L and makes only the executable estimate stale/unavailable. `valuation.calc_ts` is the worker's valuation time. The valuation never writes ledger rows or fills.
**Measured (cloud container, loopback, 45 s, 129 samples, TEST worker on live prices):** mark age p50 87 ms, p95 142 ms, max 144 ms; book age p50 74 ms, p95 128 ms; valuation frames every 1.002 s (p95 1.024 s); calculation-to-browser latency 1-2 ms. This measures THIS container's loopback path, not a Windows machine and not a remote network. Declared targets: mark and book age < 10 s (staleness threshold), valuation refresh about 1 Hz.

## 7. Unsettled funding
`unsettled_funding_estimate.usdt` = −s·rate·Q·mark for the next settlement if the position is still open then, from the latest ticker rate. It is **not booked, not part of any net or equity figure** (`included_in_any_net_figure: false`). Settled funding enters cash exactly once (unique posting key).

## 8. Field dictionary: open position (`position.live`, `position.valuation`)
| Field | Unit | Class | Meaning / formula | Missing behaviour |
|---|---|---|---|---|
| `direction`, `quantity_base` | LONG/SHORT, base coin | - | `Q` after multiplier conversion | - |
| `prices.average_entry` | USDT | - | `E` | - |
| `prices.mark`, `mark_ts`, `mark_age_ms`, `mark_status` | USDT, ms | - | exchange mark and its source time | null + UNAVAILABLE |
| `prices.estimated_close`, `close_ts`, `book_age_ms`, `close_status` | USDT | - | `X` and book source time; `OK` / `PARTIAL_LIQUIDITY` / `UNAVAILABLE` | null |
| `gross_unrealized.value/class` | USDT | gross, unrealised | `U` | null, class UNAVAILABLE |
| `roi[]`, `roi_primary_key` | % | gross unless named net | section 4 | null + reason |
| `net_if_closed.remaining_leg` | USDT | net (est.) | `gross_close`, `exit_fee_est`, `entry_fee_allocated`, `net` | null |
| `net_if_closed.whole_trade` | USDT | net (est.), whole lifetime | `net` + components and `identity_residual` | null when no OK close estimate |
| `unsettled_funding_estimate` | USDT | estimate, unbooked | section 7 | null |
| `risk_budget.recorded_usdt` | USDT | - | ledger initial risk budget | null (older records) |
| position `fees_paid`, `entry_fees`, `exit_fees`, `funding_settled`, `realized_gross` | USDT | booked | from fills/postings | 0 when none |
Timestamp/freshness: every figure belongs to `valuation.calc_ts`; ages are per input.

## 9. Field dictionary: account (`accounts[]`, additive keys marked +)
`starting_capital`, `external_cashflows` (always 0: unsupported), `realized_gross`, `fees_booked`, `funding_settled`, `realized_net`, `cash_balance` (+ `cash_balance_stored`, `cash_reconciles` = cash derived from fills equals the stored cash), `unrealized_mark` (null if any open position lacks a mark), `mark_equity`, `reserved_margin`, `available_balance`, `open_entry_notional`;
+ `closeout{equity_estimate, positions_open, positions_with_close_estimate, basis, reason}`; + `exposure{gross_notional_at_mark, net_signed_notional_at_mark, reserved_margin, notional_over_mark_equity}`;
+ `pricing{open_positions, mark_available, close_estimate_available, mark_stale, book_stale, oldest_mark_age_ms, completeness: NO_OPEN_POSITIONS|COMPLETE|PARTIAL|NONE}`; + `account_return{definition, denominator_usdt, value_pct, capital_flow_assumption}`;
`drawdown_pct` (current, from the engine's peak mark equity), + `drawdown_recorded{max_pct, samples, first_ts, last_ts, largest_gap_ms, basis}` (peak-to-trough over RECORDED one-minute samples; time before recording and between samples is unknown, intra-gap extremes are not included).

## 10. Recorded samples (schema v10, additive)
`paper_valuation_samples` (per open position per minute: mark, gross, estimated close, net if closed, margin, primary ROI, input statuses) and `paper_equity_samples` (per account per minute: cash, mark equity, closeout equity, running peak, drawdown). Outside the ledger and every decision transaction; never back-filled; unavailable values stored as NULL (an unavailable equity is not stored); pruned after 30 days; about 4,300 + 4,300 rows/day at three positions and three accounts.

## 11. Closed-trade record (`position.closed`, additive keys marked +)
`exit_price`, `exit_ts`, `reason`, `net_usdt`, `evaluable`; + `gross_usdt`, `initial_margin`, `margin_setting_leverage`, `holding_ms`, `net_return_on_initial_margin_pct`, `roi_basis`, `signal{intent, code, why}`. Gap-affected trades stay in the account and are labelled UNCERTAIN; they are excluded only from win/expectancy metrics.

## 12. Legacy simulator (NOT part of this contract)
See `live-accounting-milestone.md`: fixed $5 margin per trade, candle-simulated, no quantity/margin/fee records beyond the producer's per-trade `usd`; shown separately, labelled hypothetical, never merged into a paper account.
