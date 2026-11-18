# v3 cost filter: diagnosis (descriptive, supplementary; the registered REJECTED verdicts stand)

Evidence: `evidence/v3-diagnosis-2026-11-18.json` (`research/analyze_v3.js`; same replay and window as v3, no new parameter search). Trade sizing here is **fixed** (risk budget constant, no compounding), which is the correct basis for comparing R per trade; the K >= 3 rows reproduce the registered numbers exactly (same trades), K = 0 and 2 differ only because the registered Risk Taker run had compounded to ruin (below).

| Question | Answer |
|---|---|
| 1-3 Why K = 6, and was it the grid edge? | Mean R per trade improves **monotonically** with K (Balanced development -0.295 at K=0 to -0.124 at K=6; same shape in final and for the other analysts) because cost in R = cost bps / stop bps: a larger K keeps only wider stops. K=6 won because it was the last grid value, **not** because an optimum was found. |
| 2 Why < 200 trades? | Two causes: the filter keeps about 10% of trades at K=6, and the final period is quieter: the share of trades with stops >= 96 bps fell from 12.9% (development) to 5.5% (final) for Balanced, 3.0% vs 9.5% for Defensive. Fewer wide-stop setups exist in the later months. |
| 4 Selection bias? | The direction is not selection noise: blocked trades are worse than allowed ones in both development and final for every K and analyst (Balanced final K=6: blocked -0.383, allowed +0.039 R). The **level** (+0.04 to +0.06 R, 153 trades) is not distinguishable from zero. |
| 5 Reduced activity or better trades? | Both. Total R over the final segment: -571 R unfiltered (1,590 trades) to +9 R (153). A random 10% of trades would be about -57 R, so selection adds about +66 R, i.e. about +0.4 R per trade. Most of the *total* improvement is simply fewer losing trades. |
| 6 Do blocked trades include more losers? | Yes, per trade: blocked mean about -0.38 to -0.47 R versus allowed about -0.18 to +0.04 R. |
| 7 Does it block winners? | Yes, in proportion to everything else: at K=6 it blocks 88% of Balanced's winning trades (93% Risk Taker). Gross edge is about zero, so winners and losers are blocked alike; what it saves is costs. |
| 8 Attractive after fees and slippage? | No. Balanced K=6 earned about +9 R over about 220 days (about 0.04 R/day) with a CI that includes zero, and only by trading rarely. It is a loss-avoidance rule. |

## Portfolio survival (Risk Taker) and an evaluation flaw
* In the registered, compounding run the Risk Taker account ended at **3.11 USDT** (min 3.09): its risk per trade fell from 5.00 to 0.015 USDT, with 4,194 MIN_SIZE_EXCEEDS_BUDGET and 1,514 MIN_NOTIONAL rejections. Its "120 unfiltered final trades" were trades on a depleted account, so that comparator was meaningless (it is why the v3 note called its final unreliable). Balanced ended at 21.87 USDT; Defensive at 545.
* The simulator did not model ruin: it keeps trading at ever smaller sizes. For signal-quality comparison, fixed sizing is the right basis; the **live** rules differ (a 5% drawdown suspension halts new entries).
* Flaw found and fixed while doing this (my own, in the new fixed-sizing mode): the day-start equity kept the real, possibly negative, account value, which flipped the sign of the daily-loss test and blocked every later trade. Fixed with a regression test that fails without the fix. The original v3 files and verdicts are unchanged.
