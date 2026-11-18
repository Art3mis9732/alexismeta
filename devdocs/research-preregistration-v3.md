# Pre-registration research-prereg-v3: a cost-aware entry filter for the three rule analysts

**Committed before any filtered simulation is run.** This tests a RULE, not a model: nothing is fitted. The analysts' own rules, the risk gate, sizing, costs and exit logic stay exactly as in Slice 1 (`hist-evaluation-report.md`); a filter can only REMOVE entries, never add or change one.

## 0. Motivation (from the audits)
Slice 1 and `model-audit-2026-11-18.md`: before costs the entries are break-even; the round trip costs about 16 bps, so entries whose stop is tight relative to that pay a larger share of their risk in costs (cost per trade in R = cost bps / stop bps). A filter that skips such entries cannot create an edge (gross stays about 0) but may reduce the loss per trade. v2 showed that lowering cost in R alone leaves net negative; this experiment measures how much of the analysts' loss is avoidable by not taking the most expensive trades, and whether the result is distinguishable from noise.

## 1. Rule and parameter
Block a setup if `stop distance in bps < K x 16`, where stop distance = |entry reference - stop| / entry reference x 10,000 and 16 = the modelled round-trip cost in bps (taker 6 + 6, slippage 2 + 2). `K` in {0 (unfiltered), 2, 3, 4, 5, 6}; K = 2 means "the stop must be at least twice the round-trip cost". One K per analyst, chosen on DEVELOPMENT data only (section 3). No other parameter.

## 2. Data and simulation
The candle-only-v1 replay (`research/simulate.js`, live `decide`, live risk gate, 1-minute exit resolution) over the same 2-year public candles used for the model work (2024-12 to 2026-11), BTC/ETH/XRP, 1,000 USDT per analyst, account-level daily-loss and drawdown suspensions OFF (signal-quality mode, as in Slice 1). One continuous simulation per analyst and K. The comparison unit is **net R per trade** (net divided by the entry's risk budget); USDT totals compound and are not compared.

## 3. Split and selection (time order; nothing fitted, so no embargo is needed)
DEVELOPMENT = the first 70% of the window by time; FINAL = the last 30%. For each analyst, K is chosen as the value in {2,...,6} with the highest mean net R per trade on trades **closed in DEVELOPMENT**, requiring at least 100 such trades and an improvement of at least 0.02 R per trade over K = 0; otherwise K = 0 (no filter) is the registered outcome for that analyst. FINAL results are computed once, for the selected K.

## 4. Acceptance criteria (per analyst, on trades closed in FINAL)
* **C1** at least 200 filtered trades.
* **C2** (the filter helps): the improvement in mean net R per trade versus unfiltered (K = 0) has a **paired day-block bootstrap 95% CI lower bound above 0** (days resampled with replacement, both series on the same days, 2,000 resamples).
* **C3** (an actual edge, a much stronger claim): filtered mean net R per trade has a day-block 95% CI lower bound above 0 **and** exceeds the 95th percentile of 20 random-entry runs under the same filter, trade frequency and exits.
Verdicts: **FILTER_REDUCES_LOSS** (C1 and C2, not C3), **FILTER_EDGE** (C1, C2, C3), **REJECTED** (anything else). A filter verdict is a candidate for forward SHADOW comparison only: it never changes an active analyst without explicit approval.

## 5. Expectation and disclosure
Expected: C2 true for some analysts (removing the costliest trades helps), C3 false (gross is about 0). Three analysts are tested separately; no multiple-comparison adjustment is made and none of the criteria changes. FINAL (the last 30%) overlaps the period already scored in Slice 1 with the unfiltered rules, which does not matter for K selection (made on DEVELOPMENT only) but means the unfiltered FINAL numbers are not new information.
