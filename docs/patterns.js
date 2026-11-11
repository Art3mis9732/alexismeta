/* Pattern engine for 15-minute candles. ONE file used by both the website (browser)
 * and the history test (Node), so what the site shows is exactly what was measured.
 *
 * Input: array of CLOSED candles {t, o, h, l, c, v}, t = open time in ms (UTC), ascending,
 *        15-minute spacing. Every event at bar i uses only bars <= i (no look-ahead).
 *
 * Rule sources (see docs/SOURCES.md):
 *   [V]  Zerodha Varsity Module 2 "Technical Analysis" PDF (candlestick rules, volume, EMA)
 *   [S]  SMB Capital "Best Scalping Strategy" (VWAP pullback)
 *   [B]  Brian Shannon anchored-VWAP videos (broken resistance retested as support)
 *   [A]  ADAPTATION made here because the source is written for daily stock charts:
 *        crypto trades 24/7 so candles do not gap; "big" and "small" are measured in ATR.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Patterns = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var M15 = 900000, H1 = 3600000, DAY = 86400000;

  var P = {                       // every tunable number lives here (frozen before testing)
    atrLen: 14,
    trendLen: 8, trendAtr: 1.0,   // [A] prior trend = close moved >= 1 ATR over the previous 8 bars
    dojiBody: 0.05,               // [V] "virtually no real body": body <= 5% of the candle's range
    maruWick: 0.05, maruRange: 1.0,   // [V] no shadows (tiny allowed); [A] range >= 1 ATR
    spinBody: 0.30,               // [V] small body, shadows about equal
    umbShadow: 2.0, umbOther: 0.10, umbRange: 0.75,   // [V] shadow >= 2x body; [A] range >= 0.75 ATR
    engulfBody: 0.5,              // [A] engulfing candle body >= 0.5 ATR
    longBody: 0.7,                // [A] "long" candle body >= 0.7 ATR (harami / piercing / stars)
    haramiMax: 0.5,               // [A] inside candle body <= 50% of the long candle's body
    starMid: 0.30,                // [V] middle candle is a doji/spinning top: body <= 30% of P1 body
    tolBps: 2,                    // [A] "opens at/below the previous close" tolerance (no gaps in crypto)
    boLen: 20, volLen: 10,        // breakout of the prior 20-bar high/low; [V] volume vs last-10 average
    boWatch: 12, retestAtr: 0.25, failAtr: 0.5,       // retest / failure window and distances
    vwapMinBars: 8, vwapExt: 3.0, vwapAway: 1.0, vwapTouch: 0.25,   // [S] adapted, see below
    emaFast: 20, emaSlow: 50      // [V] price > EMA bullish; fast above slow = up-trend (on 1H bars)
  };

  var NAMES = {
    DOJI: "Doji", SPIN: "Spinning top",
    MARU_UP: "Bullish marubozu", MARU_DN: "Bearish marubozu",
    HAMMER: "Hammer", HANGING: "Hanging man", STAR_SHOOT: "Shooting star", INV_HAMMER: "Inverted hammer",
    ENGULF_UP: "Bullish engulfing", ENGULF_DN: "Bearish engulfing",
    PIERCING: "Piercing pattern", DARK_CLOUD: "Dark cloud cover",
    HARAMI_UP: "Bullish harami", HARAMI_DN: "Bearish harami",
    MORNING_STAR: "Morning star", EVENING_STAR: "Evening star",
    BO_UP: "Breakout up", BO_DN: "Breakdown",
    BO_UP_WEAK: "Breakout up (low volume)", BO_DN_WEAK: "Breakdown (low volume)",
    RETEST_UP: "Retest held (long)", RETEST_DN: "Retest held (short)",
    FAIL_UP: "Failed breakout (bull trap)", FAIL_DN: "Failed breakdown (bear trap)",
    VWAP_PB_UP: "VWAP pullback (long)", VWAP_PB_DN: "VWAP pullback (short)"
  };

  var MEANING = {
    DOJI: "Open and close almost equal: buyers and sellers are undecided.",
    SPIN: "Small body with shadows on both sides: indecision, no one in control.",
    MARU_UP: "Big candle that opened at its low and closed at its high: buyers in control all bar.",
    MARU_DN: "Big candle that opened at its high and closed at its low: sellers in control all bar.",
    HAMMER: "After a fall, sellers pushed down but buyers took it back up: possible bounce.",
    HANGING: "After a rise, a long lower shadow shows selling appeared: possible top.",
    STAR_SHOOT: "After a rise, buyers pushed up but sellers took it back down: possible top.",
    INV_HAMMER: "After a fall, buyers tried to push up; needs a green candle next to confirm.",
    ENGULF_UP: "After a fall, a green candle swallows the previous red body: buyers took over.",
    ENGULF_DN: "After a rise, a red candle swallows the previous green body: sellers took over.",
    PIERCING: "After a fall, a green candle recovers at least half of the previous red body.",
    DARK_CLOUD: "After a rise, a red candle gives back at least half of the previous green body.",
    HARAMI_UP: "After a fall, a small green candle sits inside the previous long red one: selling is stalling.",
    HARAMI_DN: "After a rise, a small red candle sits inside the previous long green one: buying is stalling.",
    MORNING_STAR: "Fall, then a small undecided candle, then a strong green candle: three-bar reversal up.",
    EVENING_STAR: "Rise, then a small undecided candle, then a strong red candle: three-bar reversal down.",
    BO_UP: "First close above the highest high of the last 20 bars, on above-average volume.",
    BO_DN: "First close below the lowest low of the last 20 bars, on above-average volume.",
    BO_UP_WEAK: "Close above the 20-bar high but volume is below average: weaker, treat with caution.",
    BO_DN_WEAK: "Close below the 20-bar low but volume is below average: weaker, treat with caution.",
    RETEST_UP: "After a breakout, price came back to the broken level and closed above it again.",
    RETEST_DN: "After a breakdown, price came back up to the broken level and closed below it again.",
    FAIL_UP: "Price closed back below the level it had just broken above: the breakout failed.",
    FAIL_DN: "Price closed back above the level it had just broken below: the breakdown failed.",
    VWAP_PB_UP: "Strong move up today, first pullback to the day's average price (VWAP), and buyers defended it.",
    VWAP_PB_DN: "Strong move down today, first bounce to the day's average price (VWAP), and sellers defended it."
  };

  function ema(vals, n) {
    var out = new Array(vals.length).fill(null), k = 2 / (n + 1), e = null, sum = 0;
    for (var i = 0; i < vals.length; i++) {
      if (i < n - 1) sum += vals[i];
      else if (i === n - 1) { sum += vals[i]; e = sum / n; out[i] = e; }
      else { e = vals[i] * k + e * (1 - k); out[i] = e; }
    }
    return out;
  }

  function atr(c, n) {            // Wilder ATR; null until n bars exist
    var out = new Array(c.length).fill(null), a = null, sum = 0;
    for (var i = 0; i < c.length; i++) {
      var tr = i === 0 ? c[i].h - c[i].l
        : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
      if (i < n) { sum += tr; if (i === n - 1) { a = sum / n; out[i] = a; } }
      else { a = (a * (n - 1) + tr) / n; out[i] = a; }
    }
    return out;
  }

  function sessionVwap(c) {       // anchored at 00:00 UTC each day (05:30 IST), typical price x volume
    var out = new Array(c.length), day = null, pv = 0, vv = 0;
    for (var i = 0; i < c.length; i++) {
      var d = Math.floor(c[i].t / DAY);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      var tp = (c[i].h + c[i].l + c[i].c) / 3;
      pv += tp * c[i].v; vv += c[i].v;
      out[i] = vv > 0 ? pv / vv : tp;
    }
    return out;
  }

  /* 1-hour trend from the 15m bars themselves. Only fully closed hours are used, and the
   * value at 15m bar i comes from the last hour that had closed by the end of bar i. */
  function hourTrend(c) {
    var hours = [], cur = null;
    for (var i = 0; i < c.length; i++) {
      var hs = Math.floor(c[i].t / H1) * H1;
      if (!cur || cur.t !== hs) { cur = { t: hs, n: 0, c: 0, last: -1 }; hours.push(cur); }
      cur.n++; cur.c = c[i].c; cur.last = i;
    }
    var full = hours.filter(function (h) { return h.n === 4; });
    var closes = full.map(function (h) { return h.c; });
    var ef = ema(closes, P.emaFast), es = ema(closes, P.emaSlow);
    var out = new Array(c.length).fill(0), k = -1;
    for (var j = 0; j < c.length; j++) {
      while (k + 1 < full.length && full[k + 1].last <= j) k++;
      if (k >= 0 && ef[k] !== null && es[k] !== null) {
        var cl = closes[k];
        out[j] = (cl > ef[k] && ef[k] > es[k]) ? 1 : (cl < ef[k] && ef[k] < es[k]) ? -1 : 0;
      }
    }
    return out;
  }

  function analyze(c) {
    var n = c.length, A = atr(c, P.atrLen), V = sessionVwap(c), T = hourTrend(c);
    var ev = [];
    function body(i) { return Math.abs(c[i].c - c[i].o); }
    function range(i) { return c[i].h - c[i].l; }
    function upper(i) { return c[i].h - Math.max(c[i].o, c[i].c); }
    function lower(i) { return Math.min(c[i].o, c[i].c) - c[i].l; }
    function green(i) { return c[i].c > c[i].o; }
    function red(i) { return c[i].c < c[i].o; }
    function prior(end) {         // trend of the P.trendLen bars ending at bar `end`
      if (end - P.trendLen < 0 || A[end] === null) return 0;
      var d = c[end].c - c[end - P.trendLen].c;
      return d >= P.trendAtr * A[end] ? 1 : d <= -P.trendAtr * A[end] ? -1 : 0;
    }
    function push(i, code, dir, kind, stop, level) {
      ev.push({ i: i, t: c[i].t, code: code, name: NAMES[code], dir: dir, kind: kind,
                stop: stop === undefined ? null : stop, level: level === undefined ? null : level,
                trend: T[i], above: c[i].c > V[i], atr: A[i], close: c[i].c });
    }

    var bo = { 1: null, "-1": null };          // breakout being watched, per direction
    var sess = null;                           // per-UTC-day state for the VWAP pullback

    for (var i = 0; i < n; i++) {
      var a = i > 0 ? A[i - 1] : null;         // ATR known BEFORE this bar: the yardstick for "big"
      var tol = c[i].c * P.tolBps / 1e4;

      // ---------- candlestick patterns: at most one per bar, 3-bar > 2-bar > 1-bar ----------
      var found = false;
      if (a && i >= 2 && A[i - 2] !== null) {
        var b1 = body(i - 2);
        if (prior(i - 2) === -1 && red(i - 2) && b1 >= P.longBody * a && body(i - 1) <= P.starMid * b1 &&
            Math.max(c[i - 1].o, c[i - 1].c) <= c[i - 2].c + tol && green(i) && c[i].c > c[i - 2].o) {
          push(i, "MORNING_STAR", 1, "candle", Math.min(c[i].l, c[i - 1].l, c[i - 2].l)); found = true;
        } else if (prior(i - 2) === 1 && green(i - 2) && b1 >= P.longBody * a && body(i - 1) <= P.starMid * b1 &&
            Math.min(c[i - 1].o, c[i - 1].c) >= c[i - 2].c - tol && red(i) && c[i].c < c[i - 2].o) {
          push(i, "EVENING_STAR", -1, "candle", Math.max(c[i].h, c[i - 1].h, c[i - 2].h)); found = true;
        }
      }
      if (!found && a && i >= 1) {
        var pt = prior(i - 1), bp = body(i - 1), bc = body(i);
        var lo2 = Math.min(c[i].l, c[i - 1].l), hi2 = Math.max(c[i].h, c[i - 1].h);
        if (pt === -1 && red(i - 1) && green(i) && c[i].o <= c[i - 1].c + tol) {
          if (c[i].c > c[i - 1].o && bc >= P.engulfBody * a) { push(i, "ENGULF_UP", 1, "candle", lo2); found = true; }
          else if (bp >= P.longBody * a && c[i].c >= (c[i - 1].o + c[i - 1].c) / 2 && c[i].c <= c[i - 1].o) {
            push(i, "PIERCING", 1, "candle", lo2); found = true;
          } else if (bp >= P.longBody * a && bc <= P.haramiMax * bp && bc > 0 && c[i].c < c[i - 1].o) {
            push(i, "HARAMI_UP", 1, "candle", lo2); found = true;
          }
        } else if (pt === 1 && green(i - 1) && red(i) && c[i].o >= c[i - 1].c - tol) {
          if (c[i].c < c[i - 1].o && bc >= P.engulfBody * a) { push(i, "ENGULF_DN", -1, "candle", hi2); found = true; }
          else if (bp >= P.longBody * a && c[i].c <= (c[i - 1].o + c[i - 1].c) / 2 && c[i].c >= c[i - 1].o) {
            push(i, "DARK_CLOUD", -1, "candle", hi2); found = true;
          } else if (bp >= P.longBody * a && bc <= P.haramiMax * bp && bc > 0 && c[i].c > c[i - 1].o) {
            push(i, "HARAMI_DN", -1, "candle", hi2); found = true;
          }
        }
      }
      if (!found && a && i >= 1 && range(i) > 0) {
        var r = range(i), b = body(i), up = upper(i), lw = lower(i), p1 = prior(i - 1);
        if (b <= P.dojiBody * r) push(i, "DOJI", 0, "candle");
        else if (up <= P.maruWick * r && lw <= P.maruWick * r && r >= P.maruRange * a)
          push(i, green(i) ? "MARU_UP" : "MARU_DN", green(i) ? 1 : -1, "candle", green(i) ? c[i].l : c[i].h);
        else if (lw >= P.umbShadow * b && up <= P.umbOther * r && r >= P.umbRange * a) {
          if (p1 === -1) push(i, "HAMMER", 1, "candle", c[i].l);
          else if (p1 === 1) push(i, "HANGING", -1, "candle", c[i].h);
        } else if (up >= P.umbShadow * b && lw <= P.umbOther * r && r >= P.umbRange * a) {
          if (p1 === 1) push(i, "STAR_SHOOT", -1, "candle", c[i].h);
          else if (p1 === -1) push(i, "INV_HAMMER", 1, "candle", c[i].l);
        } else if (b <= P.spinBody * r && up >= b && lw >= b && Math.min(up, lw) / Math.max(up, lw) >= 0.5)
          push(i, "SPIN", 0, "candle");
      }

      // ---------- breakout -> retest -> continuation or failure ----------
      [1, -1].forEach(function (d) {            // follow a breakout that is already being watched
        var w = bo[d];
        if (!w || i <= w.i0) return;
        if (i - w.i0 > P.boWatch) { bo[d] = null; return; }
        var failed = d === 1 ? c[i].c < w.level - P.failAtr * w.atr : c[i].c > w.level + P.failAtr * w.atr;
        if (failed) {
          push(i, d === 1 ? "FAIL_UP" : "FAIL_DN", -d, "structure", d === 1 ? Math.max(c[i].h, w.level) : Math.min(c[i].l, w.level), w.level);
          bo[d] = null; return;
        }
        var touched = d === 1 ? c[i].l <= w.level + P.retestAtr * w.atr : c[i].h >= w.level - P.retestAtr * w.atr;
        var held = d === 1 ? (c[i].c > w.level && green(i)) : (c[i].c < w.level && red(i));
        if (touched && held) {
          var st = d === 1 ? Math.min(c[i].l - 0.1 * w.atr, w.level - P.failAtr * w.atr)
                           : Math.max(c[i].h + 0.1 * w.atr, w.level + P.failAtr * w.atr);
          push(i, d === 1 ? "RETEST_UP" : "RETEST_DN", d, "structure", st, w.level);
          bo[d] = null;
        }
      });
      if (a && i >= P.boLen + 1) {
        var hh = -Infinity, ll = Infinity, hhP = -Infinity, llP = Infinity, vs = 0, k;
        for (k = i - P.boLen; k < i; k++) { if (c[k].h > hh) hh = c[k].h; if (c[k].l < ll) ll = c[k].l; }
        for (k = i - 1 - P.boLen; k < i - 1; k++) { if (c[k].h > hhP) hhP = c[k].h; if (c[k].l < llP) llP = c[k].l; }
        for (k = i - P.volLen; k < i; k++) vs += c[k].v;
        var volOk = c[i].v > vs / P.volLen;
        if (c[i].c > hh && c[i - 1].c <= hhP) {
          push(i, volOk ? "BO_UP" : "BO_UP_WEAK", 1, "structure", hh - P.failAtr * a, hh);
          bo[1] = { i0: i, level: hh, atr: a };
        } else if (c[i].c < ll && c[i - 1].c >= llP) {
          push(i, volOk ? "BO_DN" : "BO_DN_WEAK", -1, "structure", ll + P.failAtr * a, ll);
          bo[-1] = { i0: i, level: ll, atr: a };
        }
      }

      // ---------- first pullback to session VWAP after a strong move [S] ----------
      // [A] SMB's rule is for US stocks ("up at least one daily ATR from the open"). Here: since
      // 00:00 UTC price has extended >= 3 x ATR(15m) from the session open and was >= 1 ATR away
      // from VWAP; then the first bar that touches VWAP and closes back on the trend side.
      var dnum = Math.floor(c[i].t / DAY);
      if (!sess || sess.d !== dnum) sess = { d: dnum, open: c[i].o, hi: c[i].h, lo: c[i].l, n: 0, awayUp: false, awayDn: false, doneUp: false, doneDn: false };
      if (a && sess.n >= P.vwapMinBars) {
        if (!sess.doneUp && sess.awayUp && sess.hi - sess.open >= P.vwapExt * a &&
            c[i].l <= V[i] + P.vwapTouch * a && c[i].c > V[i] && green(i)) {
          push(i, "VWAP_PB_UP", 1, "structure", c[i].l - 0.1 * a, V[i]); sess.doneUp = true;
        } else if (!sess.doneDn && sess.awayDn && sess.open - sess.lo >= P.vwapExt * a &&
            c[i].h >= V[i] - P.vwapTouch * a && c[i].c < V[i] && red(i)) {
          push(i, "VWAP_PB_DN", -1, "structure", c[i].h + 0.1 * a, V[i]); sess.doneDn = true;
        }
      }
      if (a) {                                  // update session facts AFTER using them (no look-ahead)
        if (c[i].h - V[i] >= P.vwapAway * a) sess.awayUp = true;
        if (V[i] - c[i].l >= P.vwapAway * a) sess.awayDn = true;
      }
      if (c[i].h > sess.hi) sess.hi = c[i].h;
      if (c[i].l < sess.lo) sess.lo = c[i].l;
      sess.n++;
    }

    return { events: ev, atr: A, vwap: V, trend: T, watching: bo, session: sess, state: state(c, ev, A, V, T, bo, sess) };
  }

  /* The "right now" read at the last closed bar. A setup is only called when the 1-hour trend,
   * the side of VWAP and a fresh trigger all agree; otherwise the answer is WAIT or NO TRADE. */
  function state(c, ev, A, V, T, bo, sess) {
    var n = c.length, i = n - 1;
    if (n < 60 || A[i] === null) return { verdict: "NO DATA", reasons: ["Not enough candles yet."] };
    var px = c[i].c, tr = T[i], above = px > V[i];
    var hh = -Infinity, ll = Infinity;
    for (var k = Math.max(0, n - P.boLen); k < n; k++) { if (c[k].h > hh) hh = c[k].h; if (c[k].l < ll) ll = c[k].l; }
    var TRIG_UP = { BO_UP: 1, RETEST_UP: 1, VWAP_PB_UP: 1 }, TRIG_DN = { BO_DN: 1, RETEST_DN: 1, VWAP_PB_DN: 1 };
    var recent = ev.filter(function (e) { return e.i >= i - 1; });
    var trig = null;
    recent.forEach(function (e) { if ((tr === 1 && TRIG_UP[e.code]) || (tr === -1 && TRIG_DN[e.code])) trig = e; });
    var verdict, reasons = [];
    reasons.push("1-hour trend: " + (tr === 1 ? "UP" : tr === -1 ? "DOWN" : "FLAT / mixed"));
    reasons.push("Price is " + (above ? "above" : "below") + " today's VWAP");
    if (tr === 0) verdict = "NO TRADE";
    else if ((tr === 1) !== above) { verdict = "NO TRADE"; reasons.push("Trend and VWAP disagree"); }
    else if (trig) { verdict = tr === 1 ? "LONG SETUP" : "SHORT SETUP"; reasons.push("Trigger: " + trig.name); }
    else { verdict = "WAIT"; reasons.push("No fresh trigger in the last 2 bars"); }
    var w = bo[1] || bo[-1];
    return {
      verdict: verdict, reasons: reasons, trigger: trig, price: px, time: c[i].t, trend1h: tr,
      vwap: V[i], atr: A[i], atrPct: A[i] / px * 100, hi20: hh, lo20: ll,
      sessionHigh: sess ? sess.hi : null, sessionLow: sess ? sess.lo : null,
      watching: w ? { dir: bo[1] ? 1 : -1, level: w.level, barsLeft: P.boWatch - (i - w.i0) } : null,
      recent: ev.filter(function (e) { return e.i >= i - 3; })
    };
  }


  /* ===================== three trader profiles ===================== */
  var TRIGGERS = { BO_UP: 1, RETEST_UP: 1, VWAP_PB_UP: 1, BO_DN: 1, RETEST_DN: 1, VWAP_PB_DN: 1 };
  var CAREFUL_TRIG = { RETEST_UP: 1, RETEST_DN: 1, VWAP_PB_UP: 1, VWAP_PB_DN: 1 };

  var PROFILES = {
    aggressive: { name: "Aggressive", tf: "5m", rr: 2.0, minStopAtr: 0, lev: 50,
      desc: "Scalps 5-minute false breakouts of the day's first 4-hour range. Trades often, aims for 2x the risk." },
    neutral: { name: "Neutral", tf: "15m", rr: 1.5, minStopAtr: 0.5, lev: 10,
      desc: "Follows the 15-minute trend: 1-hour trend + side of VWAP + a breakout, retest or VWAP pullback." },
    careful: { name: "Careful", tf: "15m", rr: 1.5, minStopAtr: 1.0, lev: 3,
      desc: "Same as Neutral but only the calmer entries (retest or VWAP pullback), only when the last 24h moved the same way and the market is not unusually wild. Wider stop, low leverage, few trades." }
  };

  /* Neutral: a trigger in the direction of the 1-hour trend, on the matching side of VWAP. */
  function isSetup(e) { return !!TRIGGERS[e.code] && e.trend === e.dir && (e.dir === 1) === e.above; }

  /* Careful: a Neutral setup that also passes three filters. Returns {ok, why}. */
  function carefulCheck(c, res, e) {
    if (!isSetup(e)) return { ok: false, why: "no Neutral setup" };
    if (!CAREFUL_TRIG[e.code]) return { ok: false, why: "it is a raw breakout; Careful only takes a retest or a VWAP pullback" };
    var i = e.i;
    if (i < 96) return { ok: false, why: "not enough history" };
    if (e.dir * (c[i].c - c[i - 96].c) <= 0) return { ok: false, why: "the last 24 hours moved the other way" };
    var lo = Math.max(P.atrLen, i - 960), arr = [];
    for (var k = lo; k < i; k++) if (res.atr[k] !== null) arr.push(res.atr[k] / c[k].c);
    if (arr.length < 100) return { ok: false, why: "not enough history" };
    arr.sort(function (a, b) { return a - b; });
    if (res.atr[i] / c[i].c > arr[Math.floor(arr.length * 0.75)]) return { ok: false, why: "the market is moving more wildly than usual (top 25% of the last 10 days)" };
    return { ok: true, why: "" };
  }

  /* Aggressive: 5-minute false breakout of the first 4-hour candle of the UTC day
   * (00:00-04:00 UTC = 05:30-09:30 IST).  Source: Data Trader, "The BEST 5 Minute Scalping
   * Strategy Ever" (rules at 15:14 video).  Adaptations [A]: a "break" is a 5m CLOSE outside the
   * range; the re-entry candle must close back inside; stop = most extreme price since the break;
   * if that stop is wider than the range itself the trade is skipped (the video says to use a
   * nearer level when the breakout is too large, which is not mechanical); first signal per side
   * per day; trades end at the UTC day close if neither stop nor target is hit. */
  function rangeScalp(c) {
    var ev = [], day = null, st = null, H4 = 4 * H1;
    for (var i = 0; i < c.length; i++) {
      var d = Math.floor(c[i].t / DAY);
      if (d !== day) { day = d; st = { day: d, hi: -Infinity, lo: Infinity, n: 0, upB: false, dnB: false, upExt: -Infinity, dnExt: Infinity, doneS: false, doneL: false }; }
      if (c[i].t - d * DAY < H4) { if (c[i].h > st.hi) st.hi = c[i].h; if (c[i].l < st.lo) st.lo = c[i].l; st.n++; continue; }
      if (st.n < 44) continue;                      // range has missing candles: skip the day
      var range = st.hi - st.lo;
      if (c[i].c > st.hi) st.upB = true;
      if (c[i].c < st.lo) st.dnB = true;
      if (st.upB && c[i].h > st.upExt) st.upExt = c[i].h;
      if (st.dnB && c[i].l < st.dnExt) st.dnExt = c[i].l;
      var inside = c[i].c < st.hi && c[i].c > st.lo;
      if (st.upB && !st.doneS && inside) {
        st.doneS = true;
        if (st.upExt - c[i].c <= range) ev.push({ i: i, t: c[i].t, code: "RANGE_SHORT", name: "False breakout above the 4h range", dir: -1, stop: st.upExt, level: st.hi, rangeHi: st.hi, rangeLo: st.lo });
      }
      if (st.dnB && !st.doneL && inside) {
        st.doneL = true;
        if (c[i].c - st.dnExt <= range) ev.push({ i: i, t: c[i].t, code: "RANGE_LONG", name: "False breakout below the 4h range", dir: 1, stop: st.dnExt, level: st.lo, rangeHi: st.hi, rangeLo: st.lo });
      }
    }
    var n = c.length, last = n ? c[n - 1] : null, inRange = last && st && last.t - st.day * DAY < H4;
    return { events: ev, atr: atr(c, P.atrLen), vwap: sessionVwap(c),
      state: last ? { phase: inRange ? "forming" : (st.n < 44 ? "nodata" : "active"), hi: st.hi, lo: st.lo, upBroken: st.upB, dnBroken: st.dnB,
        upExt: st.upExt, dnExt: st.dnExt, doneS: st.doneS, doneL: st.doneL, rangeEnd: st.day * DAY + H4,
        trigger: ev.filter(function (e) { return e.i >= n - 2; }).pop() || null, price: last.c, time: last.t } : null };
  }

  /* Isolated-margin liquidation distance as a fraction of entry (long and short are within a
   * hair of each other). Same formula as bgbot/sizing.py: maintenance margin includes the
   * closing taker fee. */
  function liqDistance(lev, mmr, taker) { return 1 - (1 - 1 / lev) / (1 - mmr - taker); }

  return { analyze: analyze, rangeScalp: rangeScalp, isSetup: isSetup, carefulCheck: carefulCheck, PROFILES: PROFILES, H1: H1, DAY: DAY, ema: ema, atr: atr, sessionVwap: sessionVwap, hourTrend: hourTrend,
           liqDistance: liqDistance, NAMES: NAMES, MEANING: MEANING, PARAMS: P, M15: M15 };
});
