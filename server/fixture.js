"use strict";
/* TEST-ENVIRONMENT FIXTURE DRIVER. Controlled engineering verification only.
 *
 * It runs ONLY when the worker was started with `--env test --fixture`, on a database whose identity says TEST (a
 * separate file with its own ledger; the forward database can never be opened this way). It injects a SYNTHETIC entry
 * trigger into an otherwise real, live evidence snapshot so that the unchanged risk gate and paper engine open positions
 * and then manage them against the real trade tape. Purpose: exercise entry, live valuation, funding, exits and restart
 * mechanics end to end and make them visible in the monitor. Nothing produced here is forward evidence, and every
 * decision, snapshot and API response from this environment carries environment = TEST. */
const crypto = require("node:crypto");
const { buildLive, BAR } = require("./evidence");
const { canonical } = require("./ledger");

// Per coin: direction and stop distance (fraction of price). Tight enough that real price movement soon produces exits.
const PLAN = { BTCUSDT: { dir: 1, stopFrac: 0.0010 }, ETHUSDT: { dir: 1, stopFrac: 0.0006 }, XRPUSDT: { dir: -1, stopFrac: 0.0025 } };

function start({ engine, collector, store, health, log, identity, timers }) {
  if (identity.environment !== "TEST") throw new Error("fixture driver refused: database environment is not TEST");
  const state = { driver: "lifecycle-v1", note: "SYNTHETIC entry triggers on live prices; TEST environment only; not forward evidence", injections: 0, last_injection_ts: null };
  const inject = () => {
    for (const [sym, plan] of Object.entries(PLAN)) {
      const id = collector.idOf[sym]; if (!id) continue;
      if (store.db.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE instrument_id=? AND state='OPEN'").get(id).n) continue;
      const now = Date.now(), close = Math.floor(now / BAR) * BAR;
      const real = buildLive({ store, collector, health, instrumentId: id, barCloseTs: close, decisionTs: now });
      if (!(real.bid > 0) || !(real.ask > 0) || real.book_state !== "VALID") continue;          // never fabricate prices: wait for a live quote and a valid book
      const px = plan.dir > 0 ? real.ask : real.bid, { hash, ...body } = real;
      const snap = { ...body, fixture: state.note, missing: [], coverage_complete: true, coverage_reasons: [], trend_1h: plan.dir, above_vwap: plan.dir > 0,
        atr: px * plan.stopFrac, atr_pct: plan.stopFrac * 100, atr_pctile: 0.4, change_24h: plan.dir * 0.01,
        triggers: [{ code: plan.dir > 0 ? "RETEST_UP" : "RETEST_DN", name: "TEST FIXTURE trigger (synthetic)", dir: plan.dir, stop: px * (1 - plan.dir * plan.stopFrac), level: null }] };
      snap.hash = crypto.createHash("sha256").update(canonical(snap)).digest("hex");
      const original = engine.buildSnapshot;
      try { engine.buildSnapshot = () => snap; const r = engine.onBarClose(id, close, now); if (r.results.some(x => x.code === "OPENED")) { state.injections++; state.last_injection_ts = now; log(`TEST fixture: synthetic ${plan.dir > 0 ? "long" : "short"} setup injected for ${sym}`); } }
      finally { engine.buildSnapshot = original; }
    }
  };
  timers.push(setInterval(() => { try { inject(); } catch (e) { log("fixture: " + e.message); } }, 20000));
  setTimeout(() => { try { inject(); } catch (e) { log("fixture: " + e.message); } }, 12000);
  log("TEST fixture driver armed: synthetic entry triggers will be injected on live prices (TEST database only)");
  return state;
}

module.exports = { start, PLAN };
