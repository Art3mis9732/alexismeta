/* Legacy scheduled simulator: HYPOTHETICAL browser-side replay of scripts/paper_trader.js on the final candles this page already holds.
 *
 * The producer (a GitHub Actions job) records an open trade as open until ITS next run; that can be hours later. This module applies the producer's own rule
 * (stop wins when both are touched in one candle, a gap through the stop fills at the open, taker fee both ways plus 1 bp slippage, loss capped at the margin)
 * to final candles since the journal's last check, to say what the next run WILL record. It writes nothing, belongs to no account, and its figures are
 * labelled hypothetical wherever they are shown. closeUsd mirrors closeTrade() in scripts/paper_trader.js; tests_js/legacy.test.js runs the producer's
 * actual closeTrade source against it. */
(function (root) {
  "use strict";
  var TAKER = 0.0006, SLIP = 0.0001, MMR = 0.004, MARGIN = 5;
  /** Money result (USDT, after fees and slippage) if trade t closes at `exit` for reason `how` ("stop" | "target" | "time" | "day end"). Same arithmetic as the producer. */
  function closeUsd(t, exit, how, Pt) {
    var PR = Pt.PROFILES[t.profile], lev = PR.lev, notional = MARGIN * lev;
    var fill = how === "stop" || how === "time" || how === "day end" ? exit * (1 - t.dir * SLIP) : exit;
    var qty = notional / t.entry, fees = notional * TAKER + qty * fill * TAKER, liqD = Pt.liqDistance(lev, MMR, TAKER);
    var usd = t.dir * (fill - t.entry) * qty - fees;
    if (t.risk_pct / 100 >= liqD && how === "stop") usd = -MARGIN;
    usd = Math.max(usd, -MARGIN);
    return { usd: Math.round(usd * 1000) / 1000, fill: fill, qty: qty, notional: notional, fees: fees,
      R: Math.round(t.dir * (fill - t.entry) / (t.entry * t.risk_pct / 100) * 1000) / 1000 };
  }
  /** rows = final candles [t, o, h, l, c, v] of the trade's timeframe, ascending. Returns what the producer's next run would record, or the open state. */
  function replay(t, rows, Pt, lastPrice) {
    var step = t.tf === "5m" ? 300000 : 900000, seen = 0;
    if (!rows || !rows.length) return { state: "NO_CANDLES", note: "this page holds no candles for the trade's timeframe" };
    if (+rows[0][0] > t.entry_time) return { state: "INCOMPLETE", note: "the candles held by this page start after the trade's entry, so it cannot be checked here" };
    for (var i = 0; i < rows.length; i++) {
      var k = { t: +rows[i][0], o: +rows[i][1], h: +rows[i][2], l: +rows[i][3], c: +rows[i][4] };
      if (k.t < t.entry_time || k.t <= (t.checked_to || 0)) continue;
      seen++;
      var d = t.dir, sh = d === 1 ? k.l <= t.sl : k.h >= t.sl, th = d === 1 ? k.h >= t.tp : k.l <= t.tp;
      if (sh) { var ex = (k.t > t.entry_time && (d === 1 ? k.o < t.sl : k.o > t.sl)) ? k.o : t.sl; return Object.assign({ state: "STOP", how: "stop", candle_ts: k.t, exit: ex, candles_checked: seen }, closeUsd(t, ex, "stop", Pt)); }
      if (th) return Object.assign({ state: "TARGET", how: "target", candle_ts: k.t, exit: t.tp, candles_checked: seen }, closeUsd(t, t.tp, "target", Pt));
      if (t.max_end && k.t + step >= t.max_end) return Object.assign({ state: "TIME_LIMIT", how: t.profile === "aggressive" ? "day end" : "time", candle_ts: k.t, exit: k.c, candles_checked: seen },
        closeUsd(t, k.c, t.profile === "aggressive" ? "day end" : "time", Pt));
    }
    var out = { state: "OPEN", candles_checked: seen };
    if (typeof lastPrice === "number" && lastPrice > 0) { var PR = Pt.PROFILES[t.profile], q = MARGIN * PR.lev / t.entry; out.mark = lastPrice; out.gross_usdt = t.dir * (lastPrice - t.entry) * q; out.qty = q; out.notional = MARGIN * PR.lev; }
    return out;
  }
  var api = { TAKER: TAKER, SLIP: SLIP, MMR: MMR, MARGIN: MARGIN, closeUsd: closeUsd, replay: replay };
  root.Legacy = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
