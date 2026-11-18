"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { costFilter, pairedBootstrap, ROUND_TRIP_BPS } = require("../research/run_filter"), DAY = 86400000, T0 = Date.UTC(2026, 0, 1);
const setup = (stopBps, dir = 1) => ({ analyst: "balanced", intent: dir > 0 ? "OPEN_LONG" : "OPEN_SHORT", code: "SETUP", setup: { stop: 60000 * (1 - dir * stopBps / 1e4), target: 61000, time_exit_ts: 1 } });
const snap = { ask: 60000, bid: 60000 };

test("cost filter: blocks only entries whose stop is nearer than K x the round-trip cost, for longs and shorts; K=0 changes nothing", () => {
  const p = (d) => () => d, K = 3, thr = K * ROUND_TRIP_BPS;
  for (const dir of [1, -1]) { const f = costFilter(p(setup(thr - 1, dir)), K)("balanced", snap, {}); assert.equal(f.intent, "WAIT"); assert.equal(f.code, "COST_FILTER"); assert.equal(costFilter(p(setup(thr + 1, dir)), K)("balanced", snap, {}).intent, dir > 0 ? "OPEN_LONG" : "OPEN_SHORT"); }
  const d = setup(5); assert.equal(costFilter(() => d, 0)("balanced", snap, {}), d);
});
test("cost filter can only remove entries: abstentions and other intents pass through untouched, and it never builds a trade", () => {
  const w = { analyst: "balanced", intent: "WAIT", code: "NO_TRIGGER" }; assert.equal(costFilter(() => w, 4)("balanced", snap, {}), w);
  for (const d of [setup(1), setup(500), w]) { const out = costFilter(() => d, 4)("balanced", snap, {}); assert.ok(out === d || out.intent === "WAIT"); }
});
const trade = (day, R) => ({ closed_ts: T0 + day * DAY + 3600000, R, net: R, forced: false });
test("paired bootstrap: a filter that removes losing trades has an improvement interval above zero; an identical series has one around zero; deterministic", () => {
  const days = 60, U = [], F = []; for (let d = 0; d < days; d++) { U.push(trade(d, -0.3), trade(d, -0.9)); F.push(trade(d, -0.3)); }
  const b = pairedBootstrap(F, U, { from: T0, to: T0 + (days - 1) * DAY }); assert.ok(b.improvement_ci95[0] > 0.2, JSON.stringify(b)); assert.deepEqual(b, pairedBootstrap(F, U, { from: T0, to: T0 + (days - 1) * DAY }));
  const same = pairedBootstrap(U, U, { from: T0, to: T0 + (days - 1) * DAY }); assert.ok(same.improvement_ci95[0] <= 0 && same.improvement_ci95[1] >= 0);
});
