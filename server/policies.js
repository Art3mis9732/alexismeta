"use strict";
/* Three analyst policies, v1. Pure functions of ONE evidence snapshot (server/evidence.js) plus the analyst's own
 * paper-position context. They PROPOSE; server/risk.js decides. Differences come only from the explicit rules below.
 * Pre-registered disagreement scenarios S1-S8: devdocs/roadmap.md.
 *
 * Common to all (mandatory data controls, never relaxed):
 *   missing evidence -> NO_TRADE DATA_MISSING; any of ticker/books/trade/candle15m not HEALTHY -> NO_TRADE DATA_STALE;
 *   book not VALID -> NO_TRADE BOOK_INVALID; coverage incomplete -> NO_TRADE COVERAGE_GAP;
 *   a position already open for this analyst+coin -> WAIT POSITION_OPEN (exits are managed by the paper engine;
 *   a CLOSE/REDUCE intent is never emitted without a position);
 *   entry reference = ask (long) / bid (short) at decision; setup valid for ONE bar (expires at the next bar close).
 *
 * | rule                 | Risk Taker v1                          | Balanced v1 (= legacy Neutral)     | Defensive v1 (= legacy Careful +) |
 * |----------------------|----------------------------------------|------------------------------------|-----------------------------------|
 * | trend requirement    | 1h trend = side of VWAP, or the reclaim | 1h trend != 0 and = side of VWAP   | same as Balanced                  |
 * |                      | exception below                         |                                    |                                   |
 * | accepted triggers    | BO, BO_WEAK, RETEST, VWAP_PB            | BO, RETEST, VWAP_PB                | RETEST, VWAP_PB only              |
 * | countertrend         | trend FLAT + FAIL_UP/FAIL_DN reclaim,   | never                              | never                             |
 * |                      | only if ATR percentile <= 0.50          |                                    |                                   |
 * | extra confirmation   | none                                    | none                               | 24h change agrees; ATR pctile<=.75; depth >= 25k USDT/side within 10 bps |
 * | max spread           | 5 bps                                   | 3 bps                              | 1.5 bps                           |
 * | min stop distance    | 0.5 ATR                                 | 0.5 ATR                            | 1.0 ATR                           |
 * | target               | 2.0 R                                   | 1.5 R                              | 1.5 R                             |
 * | time exit            | 16 bars (4 h)                           | 32 bars (8 h)                      | 32 bars (8 h)                     |
 * | cooldown after exit  | 1 bar                                   | 4 bars                             | 8 bars                            |
 * | risk budget (risk.js)| 0.50 %                                  | 0.25 %                             | 0.10 %                            |
 */

const BAR = 900000;
const RULES = {
  risk_taker: { version: "risk_taker-v1", name: "Risk Taker", triggers: ["BO_UP", "BO_DN", "BO_UP_WEAK", "BO_DN_WEAK", "RETEST_UP", "RETEST_DN", "VWAP_PB_UP", "VWAP_PB_DN"],
    reclaim: { triggers: ["FAIL_UP", "FAIL_DN"], maxAtrPctile: 0.5 }, maxSpreadBps: 5, minStopAtr: 0.5, rr: 2.0, timeExitBars: 16, cooldownBars: 1 },
  balanced: { version: "balanced-v1", name: "Balanced Trader", triggers: ["BO_UP", "BO_DN", "RETEST_UP", "RETEST_DN", "VWAP_PB_UP", "VWAP_PB_DN"],
    maxSpreadBps: 3, minStopAtr: 0.5, rr: 1.5, timeExitBars: 32, cooldownBars: 4 },
  defensive: { version: "defensive-v1", name: "Defensive Trader", triggers: ["RETEST_UP", "RETEST_DN", "VWAP_PB_UP", "VWAP_PB_DN"],
    rawBreakouts: ["BO_UP", "BO_DN", "BO_UP_WEAK", "BO_DN_WEAK"], require24h: true, maxAtrPctile: 0.75, minDepthUsdt: 25000,
    maxSpreadBps: 1.5, minStopAtr: 1.0, rr: 1.5, timeExitBars: 32, cooldownBars: 8 }
};
const ANALYSTS = Object.keys(RULES);

function decide(analyst, snap, ctx = {}) {
  const R = RULES[analyst];
  if (!R) throw new Error("unknown analyst " + analyst);
  const out = (intent, code, why, setup) => ({ analyst, version: R.version, intent, code, why, setup: setup || null,
    instrument_id: snap.instrument_id, bar_close_ts: snap.bar_close_ts, evidence_hash: snap.hash, score: null, score_note: "no calibrated probability exists" });

  // ---- mandatory data controls (identical for all) ----
  if (snap.missing && snap.missing.length) return out("NO_TRADE", "DATA_MISSING", snap.missing.join("; "));
  for (const k of ["ticker", "books", "trade", "candle15m"]) if ((snap.health || {})[k] !== "HEALTHY") return out("NO_TRADE", "DATA_STALE", `${k} is ${(snap.health || {})[k] || "UNKNOWN"}`);
  if (snap.book_state !== "VALID") return out("NO_TRADE", "BOOK_INVALID", `order book ${snap.book_state}`);
  if (!snap.coverage_complete) return out("NO_TRADE", "COVERAGE_GAP", (snap.coverage_reasons || []).join(", "));
  if (ctx.position_open) return out("WAIT", "POSITION_OPEN", "a paper position is open for this coin; exits are managed by the paper engine");
  if (ctx.cooldown_until && snap.bar_close_ts < ctx.cooldown_until) return out("WAIT", "COOLDOWN", `cooldown until ${new Date(ctx.cooldown_until).toISOString()}`);

  const trend = snap.trend_1h, sideOk = (trend === 1) === !!snap.above_vwap;
  const trig = snap.triggers || [];
  let pick = null, why = "";

  // ---- countertrend reclaim (Risk Taker only, explicit) ----
  if (R.reclaim && trend === 0) {
    const t = trig.find(x => R.reclaim.triggers.includes(x.code));
    if (t && snap.atr_pctile !== null && snap.atr_pctile <= R.reclaim.maxAtrPctile) { pick = t; why = `reclaim: ${t.name} with a flat 1h trend and calm volatility (ATR pctile ${snap.atr_pctile.toFixed(2)})`; }
  }
  if (!pick) {
    if (trend === 0) return out("NO_TRADE", "NO_TREND", "1h trend is flat");
    if (!sideOk) return out("NO_TRADE", "TREND_VWAP_DISAGREE", "1h trend and the side of VWAP disagree");
    const inTrend = trig.filter(x => x.dir === trend);
    if (R.rawBreakouts && inTrend.some(x => R.rawBreakouts.includes(x.code)) && !inTrend.some(x => R.triggers.includes(x.code)))
      return out("WAIT", "RAW_BREAKOUT_NOT_ACCEPTED", "Defensive takes retests and VWAP pullbacks only");
    pick = inTrend.find(x => R.triggers.includes(x.code));
    if (!pick) return out("WAIT", "NO_TRIGGER", "trend and VWAP agree, but no accepted trigger on this bar");
    why = `${pick.name} with the 1h trend ${trend > 0 ? "up" : "down"} and price ${trend > 0 ? "above" : "below"} VWAP`;
  }
  const dir = pick.dir;

  // ---- extra confirmation (Defensive) ----
  if (R.require24h && !(snap.change_24h !== null && Math.sign(snap.change_24h) === dir)) return out("WAIT", "DAY_DISAGREES", "the last 24 hours moved the other way");
  if (R.maxAtrPctile !== undefined && !(snap.atr_pctile !== null && snap.atr_pctile <= R.maxAtrPctile)) return out("WAIT", "VOLATILITY_HIGH", `ATR percentile ${snap.atr_pctile}`);
  if (R.minDepthUsdt !== undefined && !(snap.depth_10bps && Math.min(snap.depth_10bps.bid, snap.depth_10bps.ask) >= R.minDepthUsdt))
    return out("NO_TRADE", "DEPTH", `depth within 10 bps below ${R.minDepthUsdt} USDT on one side`);
  if (!(snap.spread_bps <= R.maxSpreadBps)) return out("NO_TRADE", "SPREAD", `spread ${snap.spread_bps} bps > ${R.maxSpreadBps}`);

  // ---- setup geometry ----
  const entry = dir > 0 ? snap.ask : snap.bid;
  if (!(entry > 0) || !(snap.atr > 0) || pick.stop === null || pick.stop === undefined) return out("NO_TRADE", "DATA_MISSING", "no executable price, ATR or invalidation level");
  const risk = Math.max(dir * (entry - pick.stop), R.minStopAtr * snap.atr);
  if (!(dir * (entry - pick.stop) > 0)) return out("NO_TRADE", "INVALIDATED", `price already beyond the invalidation level ${pick.stop}`);
  const setup = { direction: dir, entry_reference: entry, stop: entry - dir * risk, target: entry + dir * R.rr * risk, rr: R.rr,
    trigger: pick.code, invalidation_level: pick.stop, time_exit_ts: snap.bar_close_ts + R.timeExitBars * BAR,
    expires_ts: snap.bar_close_ts + BAR, cooldown_bars: R.cooldownBars, est_round_trip_cost_bps: 16,
    supporting: [why], contradicting: contradictions(snap, dir), regime: { trend_1h: trend, atr_pctile: snap.atr_pctile } };
  return out(dir > 0 ? "OPEN_LONG" : "OPEN_SHORT", "SETUP", why, setup);
}

/** Evidence that argues against the proposed direction; recorded, not used to veto (except where a rule says so). */
function contradictions(snap, dir) {
  const c = [];
  if (snap.change_24h !== null && Math.sign(snap.change_24h) === -dir) c.push(`24h change ${(snap.change_24h * 100).toFixed(2)}% is against the trade`);
  if (snap.funding_rate !== null && snap.funding_rate !== undefined && Math.sign(snap.funding_rate) === dir && Math.abs(snap.funding_rate) > 0.0003)
    c.push(`funding ${(snap.funding_rate * 100).toFixed(4)}% means this side pays, and may indicate crowding`);
  if (snap.atr_pctile !== null && snap.atr_pctile > 0.9) c.push("volatility in the top 10% of the last 10 days");
  if ((snap.triggers || []).some(t => t.dir === -dir)) c.push("an opposite-direction pattern completed on the same bar");
  return c;
}

module.exports = { RULES, ANALYSTS, decide };
