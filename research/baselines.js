"use strict";
/* Simple baselines evaluated with the IDENTICAL simulator, costs, risk gate and sizing as the analysts:
 *   no_trade     : nothing (0 by definition)
 *   random_entry : at each coin and bar, with the analyst's own setup frequency, enter a RANDOM direction with a 1.0 ATR stop and the analyst's target multiple and time exit
 *   trend_always : whenever the 1h trend and the side of VWAP agree and the coin is flat, enter in the trend direction with a 1.0 ATR stop (analyst's multiple and time exit)
 * A rule set that cannot beat these after costs has shown nothing. */
const { RULES } = require("../server/policies"), { rng } = require("./metrics");
const BAR = 900000;
function mk(analyst, snap, dir, why) {
  const R = RULES[analyst], entry = dir > 0 ? snap.ask : snap.bid, risk = Math.max(1.0 * snap.atr, 0);
  if (!(entry > 0) || !(risk > 0)) return { analyst, intent: "NO_TRADE", code: "DATA_MISSING" };
  return { analyst, intent: dir > 0 ? "OPEN_LONG" : "OPEN_SHORT", code: "SETUP", why, setup: { direction: dir, entry_reference: entry, stop: entry - dir * risk, target: entry + dir * R.rr * risk, rr: R.rr, trigger: why,
    time_exit_ts: snap.bar_close_ts + R.timeExitBars * BAR, expires_ts: snap.bar_close_ts + BAR } };
}
function randomPolicy(prob, seed) { const r = rng(seed); return (analyst, snap, ctx) => { if (ctx.position_open) return { analyst, intent: "WAIT", code: "POSITION_OPEN" }; if (ctx.cooldown_until && snap.bar_close_ts < ctx.cooldown_until) return { analyst, intent: "WAIT", code: "COOLDOWN" };
  const u = r(), dir = r() < 0.5 ? 1 : -1; return u < prob ? mk(analyst, snap, dir, "RANDOM") : { analyst, intent: "WAIT", code: "NO_TRIGGER" }; }; }
function trendAlwaysPolicy() { return (analyst, snap, ctx) => { if (ctx.position_open) return { analyst, intent: "WAIT", code: "POSITION_OPEN" }; if (ctx.cooldown_until && snap.bar_close_ts < ctx.cooldown_until) return { analyst, intent: "WAIT", code: "COOLDOWN" };
  if (snap.trend_1h === 0 || (snap.trend_1h === 1) !== !!snap.above_vwap) return { analyst, intent: "NO_TRADE", code: "NO_TREND" }; return mk(analyst, snap, snap.trend_1h, "TREND_ALWAYS"); }; }
module.exports = { randomPolicy, trendAlwaysPolicy };
