// node --test tests_js/
const test = require("node:test");
const assert = require("node:assert");
const Pt = require("../docs/patterns.js");

const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);          // a UTC midnight
const bar = (i, o, h, l, c, v = 100) => ({ t: T0 + i * 900000, o, h, l, c, v });

// Flat, slightly noisy base so ATR exists and is about 1.0 (each bar range = 1).
function base(n, px = 100) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(bar(i, px, px + 0.5, px - 0.5, px));
  return out;
}
// Append a steady trend of `len` bars moving `step` per bar (range 1 each).
function trend(c, len, step) {
  let p = c[c.length - 1].c;
  for (let k = 0; k < len; k++) {
    const o = p, cl = p + step;
    c.push(bar(c.length, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl));
    p = cl;
  }
  return c;
}
const codesAt = (res, i) => res.events.filter(e => e.i === i).map(e => e.code);
const last = c => c.length - 1;

test("hammer after a fall, hanging man after a rise", () => {
  let c = trend(base(30), 9, -0.6);
  let p = c[last(c)].c;
  c.push(bar(c.length, p, p + 0.05, p - 1.5, p + 0.3));       // body 0.3, lower 1.5, upper 0.05...
  let r = Pt.analyze(c);
  assert.ok(codesAt(r, last(c)).includes("HAMMER"));
  c = trend(base(30), 9, 0.6);
  p = c[last(c)].c;
  c.push(bar(c.length, p, p + 0.05, p - 1.5, p - 0.3));
  r = Pt.analyze(c);
  assert.ok(codesAt(r, last(c)).includes("HANGING"));
});

test("same umbrella shape with no prior trend is NOT called", () => {
  const c = base(40);
  c.push(bar(c.length, 100, 100.05, 98.5, 100.3));
  const codes = codesAt(Pt.analyze(c), last(c));
  assert.ok(!codes.includes("HAMMER") && !codes.includes("HANGING"));
});

test("shooting star after a rise", () => {
  const c = trend(base(30), 9, 0.6);
  const p = c[last(c)].c;
  c.push(bar(c.length, p, p + 1.5, p - 0.05, p - 0.3));
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("STAR_SHOOT"));
});

test("bullish and bearish engulfing", () => {
  let c = trend(base(30), 9, -0.6);
  let p = c[last(c)].c;                                        // last trend bar is red (o=p+0.6, c=p)
  c.push(bar(c.length, p, p + 1.3, p - 0.1, p + 1.2));        // opens at prev close, closes above prev open
  let r = Pt.analyze(c);
  const e = r.events.find(x => x.i === last(c) && x.code === "ENGULF_UP");
  assert.ok(e && e.dir === 1);
  assert.strictEqual(e.stop, Math.min(c[last(c)].l, c[last(c) - 1].l));   // [V] lowest low of P1,P2
  c = trend(base(30), 9, 0.6);
  p = c[last(c)].c;
  c.push(bar(c.length, p, p + 0.1, p - 1.3, p - 1.2));
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("ENGULF_DN"));
});

test("piercing needs >= 50% of the red body; less is not piercing", () => {
  const mk = close => {
    const c = trend(base(30), 8, -0.6);
    const p = c[last(c)].c;
    c.push(bar(c.length, p, p + 0.1, p - 1.1, p - 1.0));       // long red: body 1.0
    c.push(bar(c.length, p - 1.0, p - 1.0 + close + 0.05, p - 1.05, p - 1.0 + close));
    return codesAt(Pt.analyze(c), last(c));
  };
  assert.ok(mk(0.6).includes("PIERCING"));      // recovers 60%
  assert.ok(!mk(0.4).includes("PIERCING"));     // recovers 40% -> harami instead
  assert.ok(mk(0.4).includes("HARAMI_UP"));
});

test("morning star and evening star", () => {
  let c = trend(base(30), 8, -0.6);
  let p = c[last(c)].c;
  c.push(bar(c.length, p, p + 0.1, p - 1.1, p - 1.0));         // P1 long red
  c.push(bar(c.length, p - 1.0, p - 0.9, p - 1.3, p - 1.1));   // P2 small, below P1 close
  c.push(bar(c.length, p - 1.1, p + 0.3, p - 1.15, p + 0.2));  // P3 green, closes above P1 open
  assert.deepStrictEqual(codesAt(Pt.analyze(c), last(c)).filter(x => x !== "BO_UP" && x !== "BO_UP_WEAK"), ["MORNING_STAR"]);
  c = trend(base(30), 8, 0.6);
  p = c[last(c)].c;
  c.push(bar(c.length, p, p + 1.1, p - 0.1, p + 1.0));
  c.push(bar(c.length, p + 1.0, p + 1.3, p + 0.9, p + 1.1));
  c.push(bar(c.length, p + 1.1, p + 1.15, p - 0.3, p - 0.2));
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("EVENING_STAR"));
});

test("doji and marubozu", () => {
  let c = base(40);
  c.push(bar(c.length, 100, 100.6, 99.4, 100.02));
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("DOJI"));
  c = base(40);
  c.push(bar(c.length, 100, 101.52, 99.99, 101.5));            // range 1.53 >= ATR, tiny wicks
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("MARU_UP"));
});

test("breakout -> retest held", () => {
  const c = base(40);                                           // 20-bar high = 100.5
  c.push(bar(c.length, 100, 101.3, 99.9, 101.2, 500));         // closes above on high volume
  let r = Pt.analyze(c);
  const b = r.events.find(e => e.i === last(c) && e.code === "BO_UP");
  assert.ok(b && b.level === 100.5);
  c.push(bar(c.length, 101.2, 101.4, 100.9, 101.0));           // drifts
  c.push(bar(c.length, 100.9, 101.1, 100.55, 101.05));         // touches level+0.25ATR zone, closes green above
  r = Pt.analyze(c);
  const rt = r.events.find(e => e.code === "RETEST_UP");
  assert.ok(rt && rt.i === last(c) && rt.dir === 1 && rt.stop < 100.5);
});

test("breakout -> failure (bull trap) is flagged bearish", () => {
  const c = base(40);
  c.push(bar(c.length, 100, 101.3, 99.9, 101.2, 500));
  c.push(bar(c.length, 101.2, 101.3, 99.6, 99.7));             // closes below level - 0.5 ATR
  const r = Pt.analyze(c);
  const f = r.events.find(e => e.code === "FAIL_UP");
  assert.ok(f && f.i === last(c) && f.dir === -1);
  assert.ok(!r.events.some(e => e.code === "RETEST_UP"));
});

test("low-volume breakout is labelled weak", () => {
  const c = base(40);
  c.push(bar(c.length, 100, 101.3, 99.9, 101.2, 50));
  assert.ok(codesAt(Pt.analyze(c), last(c)).includes("BO_UP_WEAK"));
});

test("VWAP pullback long: strong session move, first touch of VWAP, green close above", () => {
  const c = base(96);                                           // one full flat UTC day
  let p = 100;
  for (let k = 0; k < 10; k++) { c.push(bar(c.length, p, p + 0.9, p - 0.1, p + 0.8, 300)); p += 0.8; }   // new day: rally
  for (let k = 0; k < 30; k++) {                                // slow drift down toward VWAP
    const r0 = Pt.analyze(c), v = r0.vwap[last(c)];
    if (p - 0.3 <= v + 0.2) break;
    c.push(bar(c.length, p, p + 0.1, p - 0.4, p - 0.3, 50)); p -= 0.3;
  }
  const v = Pt.analyze(c).vwap[last(c)];
  c.push(bar(c.length, p, v + 0.5, v - 0.05, v + 0.4, 200));   // dips to VWAP, closes green above it
  const r = Pt.analyze(c);
  const e = r.events.find(x => x.code === "VWAP_PB_UP");
  assert.ok(e && e.i === last(c) && e.stop < c[last(c)].l);
});

test("no look-ahead: changing the future never changes past events", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const c = []; let p = 100;
  for (let i = 0; i < 900; i++) {
    const o = p, cl = p * (1 + (rnd() - 0.5) * 0.01);
    c.push(bar(i, o, Math.max(o, cl) * (1 + rnd() * 0.002), Math.min(o, cl) * (1 - rnd() * 0.002), cl, 50 + rnd() * 200));
    p = cl;
  }
  const cut = 600;
  const a = Pt.analyze(c.slice(0, cut)).events;
  const b = Pt.analyze(c).events.filter(e => e.i < cut);
  assert.deepStrictEqual(b.map(e => [e.i, e.code, e.stop, e.trend]), a.map(e => [e.i, e.code, e.stop, e.trend]));
  assert.ok(a.length > 30);
});

test("1-hour trend only uses completed hours", () => {
  const c = trend(base(400), 240, 0.05);
  const t = Pt.hourTrend(c);
  assert.strictEqual(t[last(c)], 1);
  const cut = c.slice(0, c.length - 2);                         // remove 2 bars: last hour incomplete
  assert.strictEqual(Pt.hourTrend(cut)[last(cut)], Pt.hourTrend(c)[last(cut)]);
});

test("100x liquidation distance matches the Python formula", () => {
  const d = Pt.liqDistance(100, 0.004, 0.0006);
  assert.ok(Math.abs(d - (1 - 0.99 / 0.9954)) < 1e-12);
  assert.ok(d > 0.005 && d < 0.006);                            // about 0.54%
});

// ---------------- three profiles ----------------
const D0 = Date.UTC(2026, 0, 6);                    // UTC midnight
const b5 = (k, o, h, l, c) => ({ t: D0 + k * 300000, o, h, l, c, v: 100 });
function rangeDay() {                                // 48 bars of 00:00-04:00 UTC between 99 and 101
  const c = [];
  for (let k = 0; k < 48; k++) c.push(b5(k, 100, 101, 99, 100));
  return c;
}

test("aggressive: break above the 4h range then close back inside -> SELL, stop at the high since the break", () => {
  const c = rangeDay();
  c.push(b5(48, 100.5, 101.6, 100.4, 101.4));        // closes above 101: break
  c.push(b5(49, 101.4, 101.9, 101.2, 101.5));        // extreme 101.9
  c.push(b5(50, 101.5, 101.6, 100.3, 100.6));        // closes back inside
  const r = Pt.rangeScalp(c);
  assert.strictEqual(r.events.length, 1);
  const e = r.events[0];
  assert.deepStrictEqual([e.code, e.dir, e.i, e.stop, e.level], ["RANGE_SHORT", -1, 50, 101.9, 101]);
  assert.strictEqual(r.state.trigger.code, "RANGE_SHORT");
});

test("aggressive: a wick above the range without a close above is not a break", () => {
  const c = rangeDay();
  c.push(b5(48, 100.5, 101.8, 100.4, 100.9));
  c.push(b5(49, 100.9, 101.0, 100.2, 100.4));
  assert.strictEqual(Pt.rangeScalp(c).events.length, 0);
});

test("aggressive: nothing during the range-building hours, one signal per side per day, skip if stop wider than range", () => {
  const c = rangeDay().slice(0, 30);
  let r = Pt.rangeScalp(c);
  assert.strictEqual(r.state.phase, "forming");
  const d = rangeDay();
  d.push(b5(48, 100, 99.5, 98.0, 98.2));             // break below
  d.push(b5(49, 98.2, 99.6, 96.0, 99.5));            // extreme 96, back inside; stop 3.5 > range 2 -> skipped
  d.push(b5(50, 99.5, 99.6, 98.5, 98.6));            // break below again
  d.push(b5(51, 98.6, 99.8, 98.5, 99.7));            // back inside again: already used this side today
  r = Pt.rangeScalp(d);
  assert.strictEqual(r.events.length, 0);
});

test("careful rejects raw breakouts and accepts nothing that Neutral rejects", () => {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const c = []; let p = 100;
  for (let i = 0; i < 3000; i++) { const o = p, cl = p * (1 + (rnd() - 0.48) * 0.008);
    c.push(bar(i, o, Math.max(o, cl) * (1 + rnd() * 0.002), Math.min(o, cl) * (1 - rnd() * 0.002), cl, 50 + rnd() * 200)); p = cl; }
  const res = Pt.analyze(c);
  let careful = 0, neutral = 0;
  res.events.forEach(e => {
    const ok = Pt.carefulCheck(c, res, e).ok;
    if (Pt.isSetup(e)) neutral++;
    if (ok) { careful++; assert.ok(Pt.isSetup(e)); assert.ok(!/^BO_/.test(e.code)); }
  });
  assert.ok(neutral > 0 && careful < neutral);
});
