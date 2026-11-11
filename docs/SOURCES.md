# Where the rules come from, and what was changed

Retrieved with Firecrawl on 2026-11-11. "Extracted" means Firecrawl pulled the transcript and a
model summarised the rules with timestamps; the full transcripts were not read word by word.

| Source | Status | What was used |
|---|---|---|
| Zerodha Varsity, Module 2 Technical Analysis (PDF, 177 pages) | Read in full by the extractor | All candlestick definitions (pp. 15-61), volume vs 10-period average, EMA trend, 1.5 minimum reward:risk, checklist |
| Zerodha Varsity video 8, Multiple candlestick patterns (22:41) | Extracted | Engulfing 00:40, piercing / dark cloud 08:23, morning / evening star 15:20 |
| Zerodha Varsity video 7, Single candlestick patterns (16:20) | Transcript had no numeric rules | Covered by the PDF instead |
| Zerodha Varsity video 12, Trading checklist (04:49) | Extracted | Timeframe, look-back, liquidity items (context only) |
| SMB Capital, Best Scalping Strategy (02:12) | Extracted | VWAP pullback: move away 00:05, pullback 00:30, rejection 00:52, stop 01:14, target 01:21 |
| Brian Shannon, Anchored VWAP of Bitcoin (02:11) | Extracted | Broken resistance retested as support 01:12-01:14 (the retest rule) |
| Brian Shannon, Stock Market & Bitcoin 2/16/24 (12:29) | Extracted | 11:04 breakout above the anchored VWAP (context) |
| Coin Bureau, Technical Analysis (19:56) | Extracted, thin | Only moving-average crosses came out; not used beyond the EMA trend |
| Benjamin Cowen, ETH / BTC Outlook (34:01) | Extracted | Monthly-chart macro view; NOT usable intraday. The site shows a plain 24h ETH-vs-BTC comparison instead |
| Benjamin Cowen, XRP Risk Metric (18:29) | Extracted | Long-term risk bands; NOT usable intraday |
| TJR, How To Start Day Trading In 2026 (6:40:35) | Extracted, partial | Break of structure, fair value gap, inverse FVG, equilibrium were named; NOT coded yet |
| Mind Math Money, MASTER Candlestick Patterns (125 min) | Transcript NOT obtained; chapter list only | Inverted hammer added from its chapter list using the standard definition. Three methods, flags and gaps NOT coded (crypto candles do not gap) |
| Zerodha Varsity Module 9, Delta Exchange guides, CFTC advisory | Not retrieved | Bitget's own fee, margin and liquidation rules are used instead |

## Adaptations (the sources are written for daily stock charts)

1. **No gaps.** Crypto trades 24/7, so "gaps down / gaps up" in piercing, dark cloud and the star
   patterns is replaced by "opens at or beyond the previous close" within 2 basis points.
2. **Prior trend** is defined exactly: the close moved at least 1 ATR over the previous 8 bars.
3. **Big / small candles** are measured against ATR(14): marubozu range >= 1 ATR, "long" body >= 0.7 ATR,
   hammer-type range >= 0.75 ATR, engulfing body >= 0.5 ATR.
4. **VWAP pullback.** SMB's "one daily ATR from the open" becomes: since 00:00 UTC price extended at
   least 3 x ATR(15m) from the session open and at least 1 ATR away from VWAP; first touch only.
5. **Breakout** = first 15m close beyond the prior 20-bar high/low; volume compared with the last 10 bars.
   Retest and failure are judged for 12 bars after the breakout.
6. **Stops in the history test** are the pattern's own invalidation but never closer than 0.5 ATR.

All numbers live in `PARAMS` at the top of `patterns.js`. They were fixed before the first run on
real data; changing them afterwards and re-reading the same history would be curve-fitting.
