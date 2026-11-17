"use strict";
/* Pure stress detector tests (stress-v1). SYNTHETIC inputs establish expected BEHAVIOUR; they say nothing about real-world detection accuracy. */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server/stress");

const MIN = 60000, T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
/** n contiguous 1m candles from t0, gaussian returns with the given 1m sigma, volumes lognormal. */
function series(n, { sigma = 0.0004, seed = 1, t0 = T0, p0 = 60000, vol = 10 } = {}) {
  const r = rng(seed), out = []; let p = p0;
  for (let i = 0; i < n; i++) { p *= Math.exp(sigma * gauss(r)); out.push({ t: t0 + i * MIN, c: p, v: vol * Math.exp(0.3 * gauss(r)) }); }
  return out;
}
const end = c => c[c.length - 1].t + MIN;
const pxOf = (candles, nowTs, last) => ({ now: last, at: (ts, tol) => { let best = null, bd = Infinity; for (const x of candles) { const d = Math.abs(x.t + MIN - ts); if (d < bd) { bd = d; best = x; } } return best && bd <= tol ? best.c : null; } });

test("baseline: counts only contiguous returns; a gap is never bridged", () => {
  const c = series(900), withGap = c.filter((_, i) => i !== 400);
  const a = S.baselineStats(c, end(c)), b = S.baselineStats(withGap, end(c));
  assert.equal(a.n_returns, 899);
  assert.equal(b.n_returns, 897, "removing one candle removes the two returns that touch it, and nothing is interpolated");
  assert.ok(a.ready && b.ready);
});

test("baseline: warm-up is explicit and a flat series gets the sigma floor, not zero", () => {
  const short = S.baselineStats(series(300), T0 + 300 * MIN);
  assert.equal(short.ready, false);
  const flat = S.baselineStats(Array.from({ length: 800 }, (_, i) => ({ t: T0 + i * MIN, c: 60000, v: 5 })), T0 + 800 * MIN);
  assert.equal(flat.sigma_1m, S.CONFIG.baseline.sigmaFloor, "zero dispersion must not divide by zero downstream");
  const pm = S.priceMetrics({ nowTs: T0 + 800 * MIN, px: pxOf([], 0, 60000), recent: [], base: short });
  assert.equal(pm.P, null); assert.ok(pm.reasons[0].includes("baseline not ready"));
});

test("no future leakage: data after the reference end, including the scored window, cannot change the baseline", () => {
  const c = series(1500, { seed: 3 }), ref = c[1000].t + MIN;
  const clean = S.baselineStats(c.slice(0, 1001), ref), spiked = c.map((x, i) => (i > 1000 ? { ...x, c: x.c * (i % 2 ? 1.05 : 0.95), v: x.v * 50 } : x));
  assert.deepEqual(S.baselineStats(spiked, ref), S.baselineStats(c, ref));
  assert.equal(S.baselineStats(spiked, ref).sigma_1m, clean.sigma_1m);
});

test("ordinary conditions: gaussian noise never reaches ELEVATED on the price family", () => {
  const c = series(3000, { seed: 7 });
  let worst = 0;
  for (let i = 1500; i < 2990; i += 7) {                                 // scored point i; baseline ends 15 min before it
    const now = c[i].t + MIN, base = S.baselineStats(c.slice(0, i - 14), now - S.CONFIG.baseline.excludeMs);
    const pm = S.priceMetrics({ nowTs: now, px: pxOf(c.slice(0, i + 1), now, c[i].c), recent: c.slice(i - 19, i + 1), base });
    worst = Math.max(worst, S.rawSeverity(pm, { S: null, D: null }).level);
  }
  assert.equal(worst, 0);
});

test("abrupt move: a 2% fall in 5 minutes against 4 bp/min noise is CRITICAL on the price family", () => {
  const c = series(1500, { seed: 11 }), base = S.baselineStats(c, end(c) - 15 * MIN);
  const now = end(c), last = c[c.length - 1].c, then5 = last * 1.02;                // price was 2% higher 5 min ago
  const px = { now: last, at: (ts) => (Math.abs(ts - (now - 5 * MIN)) < 7000 ? then5 : last) };
  const pm = S.priceMetrics({ nowTs: now, px, recent: c.slice(-20), base });
  assert.ok(pm.P > 14, "robust z " + pm.P);
  assert.equal(pm.P_h, 5); assert.equal(pm.dir, -1);
  assert.equal(S.rawSeverity(pm, { S: null, D: null }).level, 3);
});

test("spread expansion and depth collapse; BTC-style one-tick spread has a floor and cannot divide by ~0", () => {
  const lb = { n_spread: 500, n_depth: 500, med_spread: 0.16, med_depth: 2_000_000 };
  const calm = S.liquidityMetrics({ spreadBps: 0.16, depthMin: 1_900_000, lbase: lb });
  assert.ok(calm.S < 1 && calm.D > 0.9); assert.equal(S.rawSeverity({ P: null }, calm).level, 0);
  const wide = S.liquidityMetrics({ spreadBps: 3.5, depthMin: 1_900_000, lbase: lb });    // 3.5 / max(0.16, 0.5 floor) = 7
  assert.equal(S.rawSeverity({ P: null }, wide).level, 2);
  const thin = S.liquidityMetrics({ spreadBps: 0.2, depthMin: 200_000, lbase: lb });      // 10% of normal depth
  assert.equal(S.rawSeverity({ P: null }, thin).level, 2, "liquidity alone caps at HIGH_STRESS: CRITICAL (market-wide halt of new entries) needs a price move too");
  assert.equal(S.rawSeverity({ P: S.CONFIG.thresholds.P[1] }, thin).level, 3);
  const warm = S.liquidityMetrics({ spreadBps: 5, depthMin: 1, lbase: { n_spread: 20, n_depth: 20, med_spread: null, med_depth: null } });
  assert.equal(warm.S, null); assert.equal(warm.D, null); assert.ok(warm.reasons.length === 2, "warm-up is reported, not treated as normal");
  assert.equal(S.rawSeverity({ P: null }, warm).level, null, "no family available => UNKNOWN, never NORMAL");
});

test("rules: volume only confirms price; correlated price/vol measures are one family", () => {
  const th = S.CONFIG.thresholds, lq = { S: null, D: null };
  assert.equal(S.rawSeverity({ P: 0.5, V: 0.5, A: 9 }, lq).level, 0, "huge volume alone does not raise severity");
  assert.equal(S.rawSeverity({ P: th.P[0], V: 0.1, A: 0 }, lq).level, 1);
  assert.equal(S.rawSeverity({ P: th.P[0], V: 0.1, A: th.A[1] }, lq).level, 2, "price ELEVATED + abnormal volume = HIGH");
  assert.equal(S.rawSeverity({ P: th.P[0], V: th.V[0], A: 0 }, lq).level, 1, "price and volatility both ELEVATED are still one family = ELEVATED, not HIGH");
  assert.equal(S.rawSeverity({ P: th.P[1], V: 0, A: 0 }, { S: th.S[1], D: null }).level, 3, "price HIGH + liquidity HIGH = CRITICAL");
});

test("data quality: stale ticker, invalid book, unhealthy feed, coverage gap => UNRELIABLE; warm-up liquidity => DEGRADED", () => {
  const ok = { tickerAgeMs: 800, health: { ticker: "HEALTHY", books: "HEALTHY", trade: "HEALTHY" }, bookState: "VALID", coverageComplete: true, priceFamily: true, liquidityFamily: true, candleAgeMs: 30000, oiAvailable: true };
  assert.equal(S.dataQuality(ok).quality, "VALID");
  for (const bad of [{ tickerAgeMs: 12000 }, { tickerAgeMs: null }, { bookState: "RESYNC" }, { health: { ticker: "STALE", books: "HEALTHY", trade: "HEALTHY" } }, { coverageComplete: false }, { priceFamily: false }])
    assert.equal(S.dataQuality({ ...ok, ...bad }).quality, "UNRELIABLE", JSON.stringify(bad));
  assert.equal(S.dataQuality({ ...ok, liquidityFamily: false }).quality, "DEGRADED");
  assert.equal(S.dataQuality({ ...ok, oiAvailable: false }).quality, "DEGRADED");
});

/* ------------------------------------------------------------------ state machine */
const CFG = S.CONFIG, ev = 5000;
function run(state, specs, id = "bitget:perp:BTCUSDT") {          // specs: [[ts, raw, quality]]
  const all = []; let s = state;
  for (const [ts, raw, quality = "VALID"] of specs) { const r = S.step(s, { ts, raw, quality, measures: { raw } }, CFG, id); s = r.state; all.push(...r.transitions); }
  return { s, T: all };
}
const seq = (from, to, raw, quality) => { const a = []; for (let t = from; t <= to; t += ev) a.push([t, raw, quality]); return a; };

test("state: escalation needs 30 s persistence; a short spike opens no event (deduplicated noise)", () => {
  let r = run(S.initialState(T0), seq(T0, T0 + 20000, 2));
  assert.equal(r.s.severity, "NORMAL"); assert.equal(r.T.filter(t => t.kind === "EVENT_OPEN").length, 0);
  r = run(r.s, seq(T0 + 25000, T0 + 25000, 0));           // spike ended before persistence
  assert.equal(r.s.severity, "NORMAL"); assert.equal(r.s.up_since, null);
  r = run(S.initialState(T0), seq(T0, T0 + 30000, 2));
  assert.equal(r.s.severity, "HIGH_STRESS"); const open = r.T.find(t => t.kind === "EVENT_OPEN");
  assert.equal(open.onset_ts, T0, "the event onset is the first threshold crossing, not the confirmation time");
  assert.equal(open.event_id, `stress:bitget:perp:BTCUSDT:${Math.floor(T0 / MIN) * MIN}`);
});

test("state: confirmed level is the LOWEST raw level seen while pending (no single-tick over-reaction)", () => {
  const r = run(S.initialState(T0), [[T0, 3], [T0 + 5000, 1], [T0 + 10000, 3], [T0 + 15000, 3], [T0 + 20000, 3], [T0 + 25000, 3], [T0 + 30000, 3]]);
  assert.equal(r.s.severity, "ELEVATED");
});

test("state: recovery needs a dwell at the current level; a re-spike resets it; the event closes only when NORMAL is confirmed", () => {
  let r = run(S.initialState(T0), seq(T0, T0 + 30000, 2));           // HIGH_STRESS
  const t1 = T0 + 35000;
  r = run(r.s, seq(t1, t1 + 14 * MIN, 0));
  assert.equal(r.s.severity, "HIGH_STRESS", "14 minutes below is not enough (dwell is 15)");
  r = run(r.s, [[t1 + 14 * MIN + 5000, 2]]);                          // the market re-stresses
  assert.equal(r.s.down_since, null, "a re-spike resets the recovery clock");
  const t2 = t1 + 15 * MIN;
  r = run(r.s, seq(t2, t2 + 15 * MIN, 0));
  assert.equal(r.s.severity, "NORMAL"); assert.equal(r.T.filter(t => t.kind === "EVENT_CLOSE").length, 1); assert.equal(r.s.event_id, null);
});

test("state: partial recovery steps down to the highest level seen during the dwell", () => {
  let r = run(S.initialState(T0), seq(T0, T0 + 30000, 3));            // CRITICAL
  r = run(r.s, [...seq(T0 + 35000, T0 + 35000 + 10 * MIN, 1), ...seq(T0 + 35000 + 10 * MIN + 5000, T0 + 35000 + 20 * MIN + 5000, 1)]);
  assert.equal(r.s.severity, "ELEVATED"); assert.ok(r.T.some(t => t.kind === "DEESCALATE"));
});

test("state: UNRELIABLE data neither resolves nor escalates an event; severity and its last valid time are retained", () => {
  let r = run(S.initialState(T0), seq(T0, T0 + 30000, 3));
  const lastValid = r.s.last_valid_ts;
  r = run(r.s, seq(T0 + 35000, T0 + 35000 + 40 * MIN, 0, "UNRELIABLE"));   // 40 minutes of disconnect with 'calm' garbage
  assert.equal(r.s.severity, "CRITICAL", "a disconnect must not look like recovery");
  assert.equal(r.s.quality, "UNRELIABLE"); assert.equal(r.s.last_valid_ts, lastValid); assert.equal(r.s.valid_since_ts, null);
  assert.ok(r.T.every(t => t.kind === "QUALITY_CHANGE" || t.kind === "QUALITY_CHANGE"), "only the quality change is recorded");
  const r2 = run(r.s, seq(T0 + 3 * 3600000, T0 + 3 * 3600000, 3, "VALID"));
  assert.equal(r2.s.valid_since_ts, T0 + 3 * 3600000, "recovery of data quality is timed from the first valid evaluation");
});

test("state: unknown raw (no family available) retains state and records nothing as normal", () => {
  let r = run(S.initialState(T0), seq(T0, T0 + 30000, 2));
  r = run(r.s, seq(T0 + 35000, T0 + 35000 + 30 * MIN, null, "DEGRADED"));
  assert.equal(r.s.severity, "HIGH_STRESS");
});

test("determinism: identical inputs give identical states and transitions", () => {
  const specs = [...seq(T0, T0 + 60000, 2), ...seq(T0 + 65000, T0 + 20 * MIN, 0)];
  assert.deepEqual(run(S.initialState(T0), specs), run(S.initialState(T0), specs));
});

test("baseline reference is frozen at the event onset so an ongoing crash cannot normalise itself", () => {
  const st = { ...S.initialState(T0), event_onset_ts: T0 + 600 * MIN };
  assert.equal(S.baselineRefEnd(st, T0 + 5000 * MIN), T0 + 600 * MIN - 15 * MIN);
  assert.equal(S.baselineRefEnd(S.initialState(T0), T0 + 5000 * MIN), T0 + 5000 * MIN - 15 * MIN);
});

/* ------------------------------------------------------------------ policy gate */
const st = (sev, over = {}) => ({ severity: sev, quality: "VALID", last_eval_ts: T0, valid_since_ts: T0 - 10 * MIN, ...over });
const ID = ["bitget:perp:BTCUSDT", "bitget:perp:ETHUSDT", "bitget:perp:XRPUSDT"];
const gate = (states, id, mode = "ENFORCE", now = T0 + 1000) => S.entryGate({ states, instrumentId: id, nowTs: now, mode });

test("gate: NORMAL and ELEVATED allow entries; HIGH blocks only the affected asset; CRITICAL blocks the whole market", () => {
  const s = { [ID[0]]: st("NORMAL"), [ID[1]]: st("NORMAL"), [ID[2]]: st("NORMAL") };
  assert.equal(gate(s, ID[0]).would_block, false);
  s[ID[0]] = st("ELEVATED"); assert.equal(gate(s, ID[0]).would_block, false); assert.match(gate(s, ID[0]).detail, /warning only/);
  s[ID[0]] = st("HIGH_STRESS"); assert.equal(gate(s, ID[0]).code, "STRESS_HIGH_ASSET"); assert.equal(gate(s, ID[1]).would_block, false, "ETH is unaffected by a BTC-only HIGH");
  s[ID[1]] = st("HIGH_STRESS"); assert.equal(gate(s, ID[2]).code, "STRESS_HIGH_MARKET"); assert.equal(gate(s, ID[2]).scope, "market");
  const c = { [ID[0]]: st("CRITICAL"), [ID[1]]: st("NORMAL"), [ID[2]]: st("NORMAL") };
  assert.equal(gate(c, ID[2]).code, "STRESS_CRITICAL_MARKET");
});

test("gate: unreliable data, missing state, stale monitor and the recovery window all block; SHADOW records but does not enforce", () => {
  const ok = { [ID[0]]: st("NORMAL") };
  assert.equal(gate({ [ID[0]]: st("NORMAL", { quality: "UNRELIABLE" }) }, ID[0]).code, "STRESS_DATA_UNRELIABLE");
  assert.equal(gate({}, ID[0]).code, "STRESS_UNKNOWN");
  assert.equal(gate(ok, ID[0], "ENFORCE", T0 + 31000).code, "STRESS_MONITOR_STALE", "a dead monitor is UNRELIABLE, never NORMAL");
  assert.equal(gate({ [ID[0]]: st("NORMAL", { valid_since_ts: T0 - 2 * MIN }) }, ID[0]).code, "STRESS_RECOVERY_WINDOW");
  assert.equal(gate({ [ID[0]]: st("NORMAL", { valid_since_ts: null }) }, ID[0]).code, "STRESS_RECOVERY_WINDOW");
  const sh = gate({ [ID[0]]: st("CRITICAL") }, ID[0], "SHADOW");
  assert.equal(sh.would_block, true); assert.equal(sh.enforced, false); assert.equal(sh.policy, S.POLICY_VERSION); assert.equal(sh.mode, "SHADOW");
});

test("policy table states what stops and what never stops", () => {
  assert.match(S.POLICY.summary, /never closes, reduces or re-prices/);
  assert.ok(S.POLICY.not_implemented.includes("exposure reduction"));
  assert.ok(S.POLICY.table.every(r => /managed as always|retained/.test(r.existing_positions)));
  assert.throws(() => { S.CONFIG.thresholds.P[0] = 1; }, TypeError, "configuration is immutable at runtime");
});
