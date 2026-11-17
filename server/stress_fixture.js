"use strict";
/* SYNTHETIC stress scenario for the TEST environment (started with `--env test --stress-fixture`). It exists to exercise the whole chain
 * measurements -> state machine -> persistence -> API -> browser, including the data-unreliable and recovery states, in minutes instead of
 * waiting for a real crash. Everything it produces is labelled origin=SYNTHETIC_FIXTURE, the monitor refuses it outside TEST, and the
 * database refuses it in a FORWARD file. It says nothing about detection accuracy. Timing is compressed (see config()).
 *
 * Scenario for BTC only (240 s cycle): calm | HIGH-level move | CRITICAL-level move | 10 s data outage while CRITICAL (severity must be RETAINED) |
 * CRITICAL again | calm (recovery dwell). ETH and XRP keep their REAL measurements. */
const S = require("./stress");

function config(cfg = S.CONFIG) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.version = cfg.version + "+fixture-timing";
  c.calibration = { status: "SYNTHETIC_FIXTURE", basis: "scripted scenario, compressed timing", note: "Synthetic TEST scenario. Not a measurement of any market." };
  c.persistence = { escalateMs: 5000, dwellMs: { ELEVATED: 15000, HIGH_STRESS: 20000, CRITICAL: 25000 }, maxGapMs: cfg.persistence.maxGapMs };
  c.quality = { ...cfg.quality, recoveryValidMs: 15000 };
  return S.deepFreeze(c);
}
function scenario(cfg, symbol = "BTCUSDT", t0 = Date.now()) {
  const th = cfg.thresholds, CYCLE = 240000;
  const calm = { price: { P: 0.8, V: 0.9, A: 0, P_h: 5, dir: 0, horizons: [] }, liquidity: { S: 1, D: 1 }, quality: "VALID" };
  const mv = (P, dir) => ({ price: { P, V: 1, A: 1, P_h: 5, dir, horizons: [{ h: 5, ret: dir * 0.01, z: P }] }, liquidity: { S: 1.2, D: 0.9 }, quality: "VALID" });
  return (id, t) => {
    if (!id.endsWith(symbol)) return null;
    const e = ((t - t0) % CYCLE + CYCLE) % CYCLE / 1000;
    if (e < 20) return calm;
    if (e < 50) return mv(th.P[1] * 1.15, -1);
    if (e < 75) return mv(th.P[2] * 1.3, -1);
    if (e < 85) return { ...calm, quality: "UNRELIABLE" };           // a disconnect during the crash: calm-looking garbage must NOT resolve the event
    if (e < 100) return mv(th.P[2] * 1.3, -1);
    return calm;
  };
}
module.exports = { config, scenario };
