"use strict";
/* Legacy scheduled simulator replay (docs/legacy.js): REAL journal trade + public candles, checked against the producer's own closeTrade source. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const Pt = require("../docs/patterns.js"), Legacy = require("../docs/legacy.js");
const FX = require("./fixtures/legacy/aggressive_btc_open_2026-11-17.json");
const near = (a, b, m, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${m || ""} got ${a}, expected ${b}`);
const finals = rows => rows.filter(r => r[0] + 300000 <= Date.parse("2026-11-17T10:40:00Z"));

/** the PRODUCER's closeTrade, taken from the script's own source text and run with its constants */
function producerClose(tr, exit, how, t) {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "paper_trader.js"), "utf8"), m = /function closeTrade\([\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, "closeTrade found in the producer source");
  const ctx = { Pt, MARGIN: 5, SLIP: 0.0001, TAKER: 0.0006, MMR: 0.004 }; vm.createContext(ctx); vm.runInContext(m[0] + "\nthis.closeTrade = closeTrade;", ctx);
  const copy = JSON.parse(JSON.stringify(tr)); ctx.closeTrade(copy, exit, how, t); return copy;
}

test("the pictured trade: the journal says open; replaying the producer's rule on final candles shows the STOP was touched at 09:00 UTC (after the last run at 08:25)", () => {
  const tr = FX.trade; assert.equal(tr.status, "open"); assert.equal(tr.profile, "aggressive"); assert.equal(tr.lev, 50); assert.equal(tr.margin, 5);
  assert.equal(new Date(tr.entry_time).toISOString(), "2026-11-17T06:45:00.000Z", "12:15 IST");
  const r = Legacy.replay(tr, finals(FX.candles_5m), Pt);
  assert.equal(r.state, "STOP"); assert.equal(new Date(r.candle_ts).toISOString(), "2026-11-17T09:00:00.000Z"); assert.equal(r.exit, tr.sl, "the candle opened above the stop, so the fill is at the stop price");
  assert.ok(r.candle_ts > tr.checked_to, "after the journal's last check");
  // hand arithmetic: notional 5 x 50 = 250; qty = 250 / entry; stop fill = 64257.5 x (1 - 1 x 0.0001); fees = 250 x 0.0006 + qty x fill x 0.0006
  const qty = 250 / tr.entry, fill = 64257.5 * (1 - 0.0001), gross = (fill - tr.entry) * qty, fees = 250 * 0.0006 + qty * fill * 0.0006;
  near(r.qty, qty); near(r.fill, fill); near(r.fees, fees); near(r.usd, Math.round((gross - fees) * 1000) / 1000, "result by hand (USDT)", 5e-4);
  assert.ok(r.usd < -0.9 && r.usd > -1.1, "about a one-R loss: " + r.usd);
  const prod = producerClose(tr, r.exit, "stop", r.candle_ts);
  assert.equal(prod.status, "closed"); assert.equal(r.usd, prod.usd, "identical to the producer's own closeTrade"); assert.equal(r.R, prod.R);
});

test("replay equals the producer's closeTrade for target, stop, time and day-end exits, long and short, on every profile", () => {
  for (const profile of ["aggressive", "neutral", "careful"]) for (const dir of [1, -1]) for (const [how, mult] of [["target", 1.004], ["stop", 0.996], ["time", 1.001], ["day end", 0.999]]) {
    const lev = Pt.PROFILES[profile].lev, entry = 50000, tr = { id: "x", profile, sym: "BTCUSDT", tf: "15m", dir, entry, entry_time: 1, sl: entry - dir * 400, tp: entry + dir * 600, risk_pct: 0.8, lev, margin: 5, status: "open" };
    const exit = entry * mult, mine = Legacy.closeUsd(tr, exit, how, Pt), prod = producerClose(tr, exit, how, 2);
    assert.equal(mine.usd, prod.usd, `${profile} ${dir} ${how}`); assert.equal(mine.R, prod.R);
  }
});

test("liquidation cap: a stop wider than the liquidation distance loses the whole margin, exactly as the producer does", () => {
  const tr = { id: "x", profile: "aggressive", sym: "BTCUSDT", tf: "5m", dir: 1, entry: 50000, entry_time: 1, sl: 49000, tp: 52000, risk_pct: 2.0, lev: 50, margin: 5, status: "open" };
  const mine = Legacy.closeUsd(tr, 49000, "stop", Pt), prod = producerClose(tr, 49000, "stop", 2);
  assert.equal(mine.usd, -5); assert.equal(prod.usd, -5);
});

test("rule details: stop wins when both are touched in one candle; a gap through the stop fills at the open; candles up to checked_to are not re-checked", () => {
  const base = { id: "x", profile: "neutral", sym: "BTCUSDT", tf: "15m", dir: 1, entry: 100, entry_time: 1000, sl: 99, tp: 102, risk_pct: 1, lev: 10, margin: 5, status: "open", max_end: 0, checked_to: 1000 };
  const c = (t, o, h, l, cl) => [t, o, h, l, cl, 1];
  assert.equal(Legacy.replay(base, [c(1000, 100, 100.5, 99.5, 100), c(1900000, 100, 103, 98, 100)], Pt).state, "STOP", "both touched: the stop wins");
  const g = Legacy.replay(base, [c(1000, 100, 100.5, 99.5, 100), c(1900000, 97, 98, 96, 97)], Pt); assert.equal(g.state, "STOP"); assert.equal(g.exit, 97, "gapped through the stop: fills at the open");
  assert.equal(Legacy.replay(base, [c(1000, 100, 100.5, 99.5, 100), c(1900000, 100, 102.5, 99.5, 102)], Pt).state, "TARGET");
  const old = Legacy.replay({ ...base, checked_to: 1900000 }, [c(1000, 100, 100.5, 99.5, 100), c(1900000, 100, 103, 98, 100)], Pt); assert.equal(old.state, "OPEN", "a candle at or before checked_to was already examined by the producer");
  const timed = Legacy.replay({ ...base, max_end: 2800000 }, [c(1000, 100, 100.4, 99.6, 100), c(1900000, 100, 100.4, 99.6, 100.1)], Pt); assert.equal(timed.state, "TIME_LIMIT"); assert.equal(timed.how, "time");
});

test("open and unavailable states: hypothetical mark P&L uses the same quantity (notional / entry); missing or late candles are reported, never guessed", () => {
  const t = { ...FX.trade }, rows = finals(FX.candles_5m).filter(r => r[0] <= Date.parse("2026-11-17T08:50:00Z"));
  const r = Legacy.replay(t, rows, Pt, 64500);                                                  // before the stop candle: still open at a price of 64,500
  assert.equal(r.state, "OPEN"); near(r.qty, 250 / t.entry); near(r.gross_usdt, (64500 - t.entry) * 250 / t.entry); assert.equal(r.notional, 250);
  assert.equal(Legacy.replay(t, [], Pt).state, "NO_CANDLES");
  assert.equal(Legacy.replay(t, finals(FX.candles_5m).filter(x => x[0] > t.entry_time), Pt).state, "INCOMPLETE", "candles start after the entry: not guessed");
  assert.equal(Legacy.replay(t, rows, Pt).gross_usdt, undefined, "no price, no mark P&L");
});

test("the published journal's headline numbers are reproducible from its own trades (audit of what the summary cards mean)", () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "legacy", "journal_published_2026-11-17.json"), "utf8")).updated_utc, "2026-11-17 08:25:53", "the fixture is the journal shown in the screenshot");
  // a committed copy of the REAL published journal (gh-pages journal.json, producer run 2026-11-17 08:25:53 UTC): the working-tree docs/data/journal.json is a pipeline artefact that is not in the repository
  const J = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "legacy", "journal_published_2026-11-17.json"), "utf8"));
  for (const p of ["aggressive", "neutral", "careful"]) {
    const L = J.trades.filter(t => t.profile === p && t.status === "closed"), s = J.summary[p];
    assert.equal(s.closed, L.length); assert.equal(s.wins, L.filter(t => t.usd > 0).length);
    near(s.usd, Math.round(L.reduce((a, t) => a + t.usd, 0) * 100) / 100, p + " usd = sum of per-trade results (closed only, after fees and slippage)", 6e-3);
    near(s.R, Math.round(L.reduce((a, t) => a + t.R, 0) * 100) / 100, p + " R = SUM of per-trade R multiples (gross, before fees)", 6e-3);
    assert.equal(s.open, J.trades.filter(t => t.profile === p && t.status === "open").length);
  }
});
