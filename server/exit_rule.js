"use strict";
/* The simulator's exit rule on one 1-minute candle, shared by the historical replay and the forward shadow resolver so both use the same code. */
/** THE exit rule on one 1m candle for a position {side, stop, target, time_exit_ts}: returns {px, reason, ambiguous} or null. Shared with the fill-parity validation so both use the same code. */
function exitOnCandle(p, c) {
  if (c.t >= p.time_exit_ts) return { px: c.o, reason: "time_exit", ambiguous: false };
  const stopHit = p.side > 0 ? c.l <= p.stop : c.h >= p.stop, tgtHit = p.side > 0 ? c.h >= p.target : c.l <= p.target;
  if (stopHit) { const gap = p.side > 0 ? c.o < p.stop : c.o > p.stop; return { px: gap ? c.o : p.stop, reason: "stop", ambiguous: tgtHit }; }
  if (tgtHit) return { px: p.target, reason: "target", ambiguous: false };
  return null;
}
module.exports = { exitOnCandle };
