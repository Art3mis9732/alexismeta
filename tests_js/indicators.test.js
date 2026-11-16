"use strict";
/* Independent reference fixtures for the indicator engine (docs/patterns.js). Expected values are CLOSED-FORM results
 * derived by hand for constructed series, not outputs copied from the implementation.
 * Series A: closes rise by exactly 1 per bar, high = close + 1, low = close - 1, constant volume, one UTC session. */
const test = require("node:test");
const assert = require("node:assert/strict");
const Pt = require("../docs/patterns.js");

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0), M15 = 900000;
const near = (a, b, tol, m) => assert.ok(a !== null && Math.abs(a - b) <= tol, `${m}: got ${a}, expected ${b}`);
const linear = n => Array.from({ length: n }, (_, i) => ({ t: T0 + i * M15, o: 100 + i - 1, h: 100 + i + 1, l: 100 + i - 1, c: 100 + i, v: 10 }));

test("EMA of a straight line lags by (n-1)/2; MACD(12,26,9) = 7 exactly, histogram 0", () => {
  const c = linear(90), I = Pt.indicators(c), i = 89, px = c[i].c;
  near(I.ema20[i], px - 9.5, 1e-9, "EMA20");      // fixed point of e = k*c + (1-k)*e_prev on a unit-slope line: lag (1-k)/k = (n-1)/2
  near(I.ema50[i], px - 24.5, 1e-9, "EMA50");
  near(I.macd[i], 7, 1e-9, "MACD = (c-5.5) - (c-12.5)");
  near(I.macdSignal[i], 7, 1e-9, "signal"); near(I.macdHist[i], 0, 1e-9, "histogram");
  assert.equal(I.ema20[18], null, "no EMA20 before 20 bars exist (warm-up)"); assert.equal(I.ema50[48], null);
});

test("Bollinger(20,2) on consecutive integers: sd = sqrt(33.25), %B = 0.5 + 9.5 / (4 sd)", () => {
  const c = linear(60), I = Pt.indicators(c), i = 59, sd = Math.sqrt((20 * 20 - 1) / 12);   // population sd of 20 consecutive integers
  near(I.pctB[i], 0.5 + 9.5 / (4 * sd), 1e-9, "%B");                                         // = 0.911879...
  near(I.bbWidth[i], 4 * sd / (c[i].c - 9.5) * 100, 1e-9, "band width %");
  assert.equal(I.pctB[18], null, "warm-up");
});

test("Wilder ATR(14) = 2, +DI = 50, -DI = 0, ADX = 100, stochastic %K = 100 on the rising series", () => {
  const c = linear(80), I = Pt.indicators(c), R = Pt.analyze(c), i = 79;
  near(R.atr[i], 2, 1e-9, "ATR: true range = max(h-l, |h-prevC|, |l-prevC|) = max(2, 2, 0)");
  near(I.plusDI[i], 50, 1e-9, "+DI = 100 * smoothed(+DM=1) / smoothed(TR=2)"); near(I.minusDI[i], 0, 1e-9, "-DI");
  near(I.adx[i], 100, 1e-9, "ADX"); near(I.stochK[i], 100 * 14 / 15, 1e-9, "%K = (c - low14) / (high14 - low14) = 14/15");
  near(I.rsi[i], 100, 1e-9, "RSI with no down moves");
  assert.equal(R.atr[12], null, "no ATR before 14 bars");
});

test("Wilder RSI(14): seven +2 moves and seven -1 moves give average gain 1, average loss 0.5 -> RSI = 66.666...", () => {
  let p = 100; const c = [{ t: T0, o: p, h: p, l: p, c: p, v: 1 }];
  for (let i = 1; i <= 14; i++) { p += i % 2 ? 2 : -1; c.push({ t: T0 + i * M15, o: p, h: p, l: p, c: p, v: 1 }); }
  near(Pt.indicators(c).rsi[14], 100 - 100 / (1 + 1 / 0.5), 1e-9, "RSI at the first defined bar");
  assert.equal(Pt.indicators(c).rsi[13], null, "RSI needs 14 changes");
});

test("session VWAP = volume-weighted typical price since 00:00 UTC, and resets at the next UTC day", () => {
  const c = linear(100), R = Pt.analyze(c);
  near(R.vwap[9], 104.5, 1e-9, "typical price = (h+l+c)/3 = ((c+1)+(c-1)+c)/3 = c; equal volumes -> mean of closes 100..109");
  near(R.vwap[96], c[96].c, 1e-9, "bar 96 opens a new UTC day: VWAP restarts from that bar alone");
  const heavy = linear(3); heavy[2].v = 80;                                   // weights 10, 10, 80
  near(Pt.analyze(heavy).vwap[2], (10 * 100 + 10 * 101 + 80 * 102) / 100, 1e-9, "volume weighting");
});

test("OBV adds volume on up closes and subtracts on down closes; correlated indicators are not independent confirmation", () => {
  const c = linear(5); c[3].c = c[2].c - 0.5;                                  // one down close
  const obv = Pt.indicators(c).obv;
  assert.deepEqual(obv, [0, 10, 20, 10, 20]);
  // RSI, stochastic, %B and MACD are all functions of the same closes: on a pure trend they all read "strong" together.
  const I = Pt.indicators(linear(90));
  assert.ok(I.rsi[89] === 100 && I.stochK[89] > 90 && I.pctB[89] > 0.9, "all agree because they share one input, not because four sources agree");
});
