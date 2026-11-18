"use strict";
/* Dataset builder tests on SYNTHETIC candles (no data/hist). Properties the pre-registration depends on: features are point-in-time, labels depend on the future,
 * the template trade follows the stated cost rules, splits are time-ordered with an embargo and a purge. */
const test = require("node:test"), assert = require("node:assert/strict");
const D = require("../research/dataset"), SN = require("../research/snapshots"), { rng } = require("../research/metrics");
const BAR = 900000, MIN = 60000, T0 = Date.UTC(2026, 0, 1);
function walk(n, seed = 5) { const r = rng(seed); let px = 60000; const rows = []; for (let i = 0; i < n; i++) { const o = px, d = (r() - 0.5) * 120, c = o + d, h = Math.max(o, c) + r() * 40, l = Math.min(o, c) - r() * 40; rows.push({ open_ts: T0 + i * BAR, o, h, l, c, base_vol: 100 + r() * 50, final: 1 }); px = c; } return rows; }
function m1From(rows) { const out = []; for (const b of rows) for (let k = 0; k < 15; k++) { const f = k / 15, px = b.o + (b.c - b.o) * f, nx = b.o + (b.c - b.o) * (f + 1 / 15); out.push({ t: b.open_ts + k * MIN, o: px, h: Math.max(px, nx) + 1, l: Math.min(px, nx) - 1, c: nx, v: 1 }); } return out; }

test("features at bar i do not change when candles AFTER bar i change (point-in-time)", () => {
  const rows = walk(700), i = 500, a = SN.snapshotAt("BTCUSDT", rows, i), fa = [1, -1].map(s => D.features(a, rows, i, s));
  const alt = rows.map((r, k) => (k > i ? { ...r, o: r.o * 1.3, h: r.h * 1.3, l: r.l * 0.7, c: r.c * 1.3, base_vol: r.base_vol * 9 } : r)), b = SN.snapshotAt("BTCUSDT", alt, i), fb = [1, -1].map(s => D.features(b, alt, i, s));
  assert.deepEqual(fa, fb); assert.equal(fa[0].length, D.FEATURES.length); assert.ok(fa[0].every(Number.isFinite));
});
test("a side flips the oriented features and leaves the symmetric ones", () => {
  const rows = walk(700), i = 520, s = SN.snapshotAt("BTCUSDT", rows, i), L = D.features(s, rows, i, 1), S = D.features(s, rows, i, -1), ix = n => D.FEATURES.indexOf(n);
  assert.equal(L[ix("trend")], -S[ix("trend")]); assert.equal(L[ix("ret4")], -S[ix("ret4")]); assert.equal(L[ix("atr_pct")], S[ix("atr_pct")]); assert.ok(Math.abs(L[ix("range_pos")] + S[ix("range_pos")] - 1) < 1e-12);
});
test("label: target hit follows the stated cost rules exactly", () => {
  const rows = walk(700), i = 500, snap = SN.snapshotAt("BTCUSDT", rows, i), t = snap.bar_close_ts, atr = snap.atr, ref = snap.ask;
  const m1 = []; for (let k = 0; k < 600; k++) m1.push({ t: t - 10 * MIN + k * MIN, o: ref, h: ref, l: ref, c: ref, v: 1 }); const hit = 20 + 10; m1[hit] = { ...m1[hit], h: ref + 1.6 * atr };
  const exit0 = () => ref + 1.5 * atr, lb = D.label(snap, m1, 0, 1), T = D.TEMPLATE, entry = ref * (1 + T.slip), exit = (ref + 1.5 * atr) * (1 - T.slip), net = exit - entry - T.taker * (entry + exit);
  assert.equal(lb.reason, "target"); assert.ok(Math.abs(lb.netR - net / atr) < 1e-12); assert.equal(lb.y, net > 0 ? 1 : 0);
  assert.ok(Math.abs(lb.costR - ((exit0() - ref) - net) / atr) < 1e-12, "costR = frictionless result minus net, in R");
});
test("label depends on the future and is unresolved (null) when 1m data ends first", () => {
  const rows = walk(700), i = 500, snap = SN.snapshotAt("BTCUSDT", rows, i), t = snap.bar_close_ts, ref = snap.ask, atr = snap.atr;
  const flat = n => Array.from({ length: n }, (_, k) => ({ t: t + k * MIN, o: ref, h: ref, l: ref, c: ref, v: 1 }));
  assert.equal(D.label(snap, flat(30), 0, 1), null);
  const up = flat(600); up[5] = { ...up[5], h: ref + 2 * atr }; const dn = flat(600); dn[5] = { ...dn[5], l: ref - 2 * atr };
  assert.equal(D.label(snap, up, 0, 1).reason, "target"); assert.equal(D.label(snap, dn, 0, 1).reason, "stop"); assert.equal(D.label(snap, dn, 0, -1).reason, "target");
  assert.equal(D.label(snap, flat(600), 0, 1).reason, "time_exit"); assert.ok(D.label(snap, flat(600), 0, 1).netR < 0);                // a flat price loses the round-trip cost
});
test("split rule: time ordered, embargo >= 3 days between segments, burn-in excluded, label windows purged at the edges", () => {
  const DAY = 86400000, a = T0, b = T0 + 700 * DAY, sp = D.splitRule(a, b);
  assert.ok(sp.train[0] >= a + 14 * DAY); assert.ok(sp.train[1] + 3 * DAY <= sp.validation[0] + 1); assert.ok(sp.validation[1] + 3 * DAY <= sp.final[0] + 1); assert.ok(sp.final[1] === b);
  const frac = (x) => (x[1] - x[0]) / (b - sp.train[0]); assert.ok(Math.abs(frac(sp.train) - 0.55) < 0.01 && Math.abs(frac(sp.validation) - 0.20) < 0.01);
  const h = 32 * BAR; assert.equal(D.splitOf(sp.train[1] - h - 1, sp), "train"); assert.equal(D.splitOf(sp.train[1] - h + 1, sp), null);   // window crosses the boundary -> purged
  assert.equal(D.splitOf(sp.train[1] + DAY, sp), null);                                                                              // inside the embargo
  assert.equal(D.splitOf(sp.validation[0] + 1, sp), "validation"); assert.equal(D.splitOf(a, sp), null);
});
test("registered dataset-v1 is replaced only by an identical rebuild; a different one is refused and leaves it untouched", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-")), out = path.join(root, "dataset-v1");
  const mkBuild = (hash, mark) => (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "mark.txt"), mark); return { manifest: { matrix_sha256: hash } }; };
  fs.mkdirSync(out); fs.writeFileSync(path.join(out, "mark.txt"), "original");
  assert.throws(() => D.placeBuild({ out, registered: { matrix_sha256: "aaa" }, buildFn: mkBuild("bbb", "changed") }), /REFUSED/);
  assert.equal(fs.readFileSync(path.join(out, "mark.txt"), "utf8"), "original"); assert.ok(!fs.existsSync(out + ".build"));
  D.placeBuild({ out, registered: { matrix_sha256: "aaa" }, buildFn: mkBuild("aaa", "identical") }); assert.equal(fs.readFileSync(path.join(out, "mark.txt"), "utf8"), "identical");
  const draft = path.join(root, "dataset-draft-1"); D.placeBuild({ out: draft, registered: { matrix_sha256: "aaa" }, buildFn: mkBuild("zzz", "draft") }); assert.ok(fs.existsSync(draft));   // other directories are unrestricted
});

test("v2: ATR(1h) is point in time, uses only complete contiguous UTC hours, and refuses non-hour bars", () => {
  const rows = walk(900), H = 3600000, i = rows.findIndex((r, k) => k > 600 && (r.open_ts + BAR) % H === 0), a = D.atr1h(rows, i);
  assert.ok(a > 0 && Number.isFinite(a)); assert.equal(D.atr1h(rows, i + 1), null, "a bar that does not close on an hour boundary has no ATR(1h)");
  const alt = rows.map((r, k) => (k > i ? { ...r, o: r.o * 2, h: r.h * 2, l: r.l * 0.1, c: r.c * 2 } : r)); assert.equal(D.atr1h(alt, i), a, "candles after the decision bar change nothing");
  const gap = rows.map((r, k) => (k === i - 9 ? null : r)).filter(Boolean); assert.equal(D.atr1h(gap, gap.findIndex(r => r.open_ts === rows[i].open_ts)), null, "a missing 15-minute bar inside the lookback makes it unavailable, never an estimate");
  const bigger = rows.map((r, k) => (k > i - 40 && k <= i ? { ...r, h: r.h + 500 } : r)); assert.ok(D.atr1h(bigger, i) > a, "recent ranges do enter it");
});
test("v2: variant definitions are the registered ones and the purge works at a 96-bar horizon", () => {
  const A = D.VARIANTS.v2A, B = D.VARIANTS.v2B; assert.deepEqual([A.template.stop_atr, A.template.target_atr, A.template.time_exit_bars, A.cadence_bars, A.atr], [2, 3, 96, 1, "15m"]); assert.deepEqual([B.template.stop_atr, B.template.target_atr, B.template.time_exit_bars, B.cadence_bars, B.atr], [1, 1.5, 96, 4, "1h"]);
  const DAY = 86400000, sp = D.splitRule(T0, T0 + 700 * DAY), h = 96 * BAR; assert.equal(D.splitOf(sp.train[1] - h - 1, sp, h), "train"); assert.equal(D.splitOf(sp.train[1] - h + 1, sp, h), null); assert.equal(D.splitOf(sp.train[1] - 32 * BAR, sp, 32 * BAR), "train", "the v1 horizon would not have purged this row, the 96-bar one must");
  assert.equal(D.splitOf(sp.train[1] - 32 * BAR, sp, h), null);
  assert.equal(D.splitForVariant(sp.train[1] - 32 * BAR, sp, D.VARIANTS.v1), "train"); assert.equal(D.splitForVariant(sp.train[1] - 32 * BAR, sp, D.VARIANTS.v2A), null); assert.equal(D.splitForVariant(sp.train[1] - 32 * BAR, sp, D.VARIANTS.v2B), null);
});
test("v2: a label uses the ATR it is given (B's stop and target follow ATR(1h), not ATR(15m))", () => {
  const rows = walk(700), snap = SN.snapshotAt("BTCUSDT", rows, 500), t = snap.bar_close_ts, ref = snap.ask, big = snap.atr * 3;
  const m1 = []; for (let k = 0; k < 1600; k++) m1.push({ t: t + k * MIN, o: ref, h: ref, l: ref, c: ref, v: 1 }); m1[7] = { ...m1[7], h: ref + 1.6 * snap.atr };
  assert.equal(D.label(snap, m1, 0, 1, D.VARIANTS.v2B.template, snap.atr).reason, "target"); assert.equal(D.label(snap, m1, 0, 1, D.VARIANTS.v2B.template, big).reason, "time_exit", "with a 3x larger ATR the same move no longer reaches the target");
});
