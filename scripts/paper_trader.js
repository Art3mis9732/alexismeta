/* Automatic paper trader. Runs every 15 minutes in GitHub Actions after fetch_market.py.
 *   node scripts/paper_trader.js
 *
 * Reads the latest closed candles (docs/data/market.json) and the journal so far
 * (docs/data/journal.json), and for each profile x coin:
 *   - closes an open trade if a later candle hit its stop loss / take profit / time limit
 *   - opens a trade for every NEW signal (one open trade per profile and coin at a time)
 * Everything is decided from closed candles with the same rules as the history test:
 * entry at the open of the candle after the signal, stop wins if both are hit in one candle,
 * a gap through the stop fills at the open, taker fee both ways + 1 bp slippage each way.
 * Because it works from candles, a late or skipped GitHub run does not change the result.
 * No real orders. No API key. Money figures assume $5 margin at the profile's default leverage.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Pt = require("../docs/patterns.js");

const DATA = path.resolve(__dirname, "..", "docs", "data");
const MARKET = path.join(DATA, "market.json"), JOURNAL = path.join(DATA, "journal.json");
const TAKER = 0.0006, SLIP = 0.0001, MMR = 0.004, MARGIN = 5, HOLD15 = 32;

const toC = rows => (rows || []).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

function closeTrade(tr, exit, how, t) {
  const PR = Pt.PROFILES[tr.profile], lev = PR.lev, notional = MARGIN * lev;
  const fill = how === "stop" || how === "time" || how === "day end" ? exit * (1 - tr.dir * SLIP) : exit;
  const qty = notional / tr.entry;
  const fees = notional * TAKER + qty * fill * TAKER;
  const liqD = Pt.liqDistance(lev, MMR, TAKER);
  let usd = tr.dir * (fill - tr.entry) * qty - fees;
  if (tr.risk_pct / 100 >= liqD && how === "stop") usd = -MARGIN;        // liquidated before the stop
  usd = Math.max(usd, -MARGIN);
  Object.assign(tr, { status: "closed", exit: fill, exit_time: t, how, usd: Math.round(usd * 1000) / 1000,
    R: Math.round(tr.dir * (fill - tr.entry) / (tr.entry * tr.risk_pct / 100) * 1000) / 1000 });
}

/* Walk candles after the entry; return true if the trade closed. */
function manage(tr, c, endTime) {
  for (const k of c) {
    if (k.t < tr.entry_time || k.t <= (tr.checked_to || 0)) continue;
    const d = tr.dir, sh = d === 1 ? k.l <= tr.sl : k.h >= tr.sl, th = d === 1 ? k.h >= tr.tp : k.l <= tr.tp;
    if (sh) { closeTrade(tr, (k.t > tr.entry_time && (d === 1 ? k.o < tr.sl : k.o > tr.sl)) ? k.o : tr.sl, "stop", k.t); return true; }
    if (th) { closeTrade(tr, tr.tp, "target", k.t); return true; }
    tr.checked_to = k.t;
    if (endTime && k.t + (tr.tf === "5m" ? 300000 : 900000) >= endTime) { closeTrade(tr, k.c, tr.profile === "aggressive" ? "day end" : "time", k.t); return true; }
  }
  return false;
}

function open(J, profile, sym, e, c, i, minAtr, atrv) {
  if (i + 1 >= c.length) return "pending";                 // next candle not closed yet: try next run
  const PR = Pt.PROFILES[profile], entry = c[i + 1].o * (1 + e.dir * SLIP);
  let risk = e.dir * (entry - e.stop);
  if (!(risk > 0)) return "void";
  if (minAtr && atrv) risk = Math.max(risk, minAtr * atrv);
  const tr = { id: `${profile}|${sym}|${e.t}`, profile, sym, tf: PR.tf, signal: e.name, signal_time: e.t + (PR.tf === "5m" ? 300000 : 900000),
    dir: e.dir, entry, entry_time: c[i + 1].t, sl: entry - e.dir * risk, tp: entry + e.dir * PR.rr * risk,
    risk_pct: Math.round(risk / entry * 1e6) / 1e4, lev: PR.lev, margin: MARGIN, status: "open" };
  tr.max_end = PR.tf === "5m" ? (Math.floor(e.t / Pt.DAY) + 1) * Pt.DAY : c[i + 1].t + HOLD15 * 900000;
  J.trades.push(tr);
  return "opened";
}

function main() {
  const M = load(MARKET, null);
  if (!M) { console.error("no market.json"); process.exit(1); }
  const J = load(JOURNAL, null) || { started_utc: M.generated_at_utc, started_ms: M.generated_at_ms, cursor: {}, trades: [] };
  let opened = 0, closed = 0;
  for (const sym of Object.keys(M.symbols)) {
    const c15 = toC(M.symbols[sym].candles15m), c5 = toC(M.symbols[sym].candles5m);
    const sets = [];
    if (c15.length > 200) {
      const res = Pt.analyze(c15);
      res.events.forEach(e => {
        if (!Pt.isSetup(e)) return;
        sets.push({ profile: "neutral", e, c: c15, minAtr: Pt.PROFILES.neutral.minStopAtr, atr: e.atr });
        if (Pt.carefulCheck(c15, res, e).ok) sets.push({ profile: "careful", e, c: c15, minAtr: Pt.PROFILES.careful.minStopAtr, atr: e.atr });
      });
    }
    if (c5.length > 200) Pt.rangeScalp(c5).events.forEach(e => sets.push({ profile: "aggressive", e, c: c5, minAtr: 0, atr: 0 }));
    for (const profile of ["aggressive", "neutral", "careful"]) {
      const key = profile + "|" + sym, c = profile === "aggressive" ? c5 : c15;
      if (!c.length) continue;
      const evs = sets.filter(x => x.profile === profile && x.e.t > (J.cursor[key] || J.started_ms - 1)).sort((a, b) => a.e.t - b.e.t);
      for (const x of evs) {
        const openTr = J.trades.find(t => t.profile === profile && t.sym === sym && t.status === "open");
        if (openTr) {                                       // bring it up to this signal's time first
          if (manage(openTr, c.filter(k => k.t <= x.e.t), openTr.max_end)) closed++;
          if (openTr.status === "open") { J.cursor[key] = x.e.t; continue; }   // still in a trade: skip this signal
        }
        const i = c.findIndex(k => k.t === x.e.t);
        const r = open(J, profile, sym, x.e, c, i, x.minAtr, x.atr);
        if (r === "pending") break;
        if (r === "opened") opened++;
        J.cursor[key] = x.e.t;
      }
      const openTr = J.trades.find(t => t.profile === profile && t.sym === sym && t.status === "open");
      if (openTr && manage(openTr, c, openTr.max_end)) closed++;
    }
  }
  J.updated_utc = M.generated_at_utc;
  const sum = {};
  for (const p of ["aggressive", "neutral", "careful"]) {
    const L = J.trades.filter(t => t.profile === p && t.status === "closed");
    sum[p] = { closed: L.length, open: J.trades.filter(t => t.profile === p && t.status === "open").length,
      wins: L.filter(t => t.usd > 0).length, usd: Math.round(L.reduce((a, t) => a + t.usd, 0) * 100) / 100,
      R: Math.round(L.reduce((a, t) => a + t.R, 0) * 100) / 100 };
  }
  J.summary = sum;
  J.trades = J.trades.slice(-2000);
  fs.writeFileSync(JOURNAL, JSON.stringify(J));
  console.log(`paper trader: +${opened} opened, ${closed} closed; summary ${JSON.stringify(sum)}`);
}
main();
