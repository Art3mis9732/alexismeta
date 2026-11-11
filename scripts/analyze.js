/* Current read for each coin from docs/data/market.json -> docs/data/read.json (+ printed summary).
 *   node scripts/analyze.js
 * Uses the same engine as the website (docs/patterns.js). */
"use strict";
const fs = require("fs");
const path = require("path");
const Pt = require("../docs/patterns.js");

const DATA = path.resolve(__dirname, "..", "docs", "data");
const market = JSON.parse(fs.readFileSync(path.join(DATA, "market.json"), "utf8"));
let stats = null;
try { stats = JSON.parse(fs.readFileSync(path.join(DATA, "stats.json"), "utf8")); } catch (e) { /* not built yet */ }

const ist = ms => new Date(ms + 19800000).toISOString().slice(0, 16).replace("T", " ") + " IST";
const utc = ms => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const out = { generated_at_utc: market.generated_at_utc, symbols: {} };
const chg = {};

for (const [sym, row] of Object.entries(market.symbols)) {
  if (!row.candles15m || row.candles15m.length < 100) continue;
  const c = row.candles15m.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const res = Pt.analyze(c), s = res.state, n = c.length;
  const pct = k => n > k ? (c[n - 1].c / c[n - 1 - k].c - 1) * 100 : null;
  chg[sym] = { h4: pct(16), h24: pct(96) };
  const mmr = row.tier1_mmr || 0.004, taker = parseFloat((row.contract || {}).taker_fee) || 0.0006;
  const liq = Pt.liqDistance(100, mmr, taker) * 100;
  const tk = row.taker_buy_sell || [], ls = row.long_short_accounts || [];
  const tkN = k => { const a = tk.slice(-k); const b = sum(a, x => x[1]), se = sum(a, x => x[2]); return b + se > 0 ? b / (b + se) : null; };
  const st = stats && stats.symbols[sym];
  const key = s.trigger ? (s.trigger.dir === 1 ? "SETUP_LONG" : "SETUP_SHORT") : null;
  out.symbols[sym] = {
    last_closed_bar: utc(c[n - 1].t + Pt.M15) + " / " + ist(c[n - 1].t + Pt.M15),
    price: s.price, verdict: s.verdict, reasons: s.reasons, trend_1h: s.trend1h,
    vwap: s.vwap, atr15m_pct: s.atrPct, hi20: s.hi20, lo20: s.lo20,
    session_high: s.sessionHigh, session_low: s.sessionLow, watching: s.watching,
    change_4h_pct: chg[sym].h4, change_24h_pct: chg[sym].h24,
    liq100_pct: liq, atr_vs_liq100: s.atrPct / liq,
    long_accounts_pct: ls.length ? ls[ls.length - 1][1] * 100 : null,
    taker_buy_share_1h: tkN(4), taker_buy_share_6h: tkN(24),
    ticker: row.ticker || null,
    setup_history: key && st && st.patterns[key] ? st.patterns[key] : null,
    last_events: res.events.slice(-8).map(e => ({ time: ist(e.t + Pt.M15), name: e.name, dir: e.dir, level: e.level, stop: e.stop, trend: e.trend }))
  };
}
if (chg.BTCUSDT) for (const sym of Object.keys(out.symbols)) {
  out.symbols[sym].vs_btc_24h_pct = chg[sym].h24 - chg.BTCUSDT.h24;
  out.symbols[sym].vs_btc_4h_pct = chg[sym].h4 - chg.BTCUSDT.h4;
}
fs.writeFileSync(path.join(DATA, "read.json"), JSON.stringify(out, null, 1));

const f = (x, d = 2) => x === null || x === undefined ? "n/a" : Number(x).toFixed(d);
for (const [sym, r] of Object.entries(out.symbols)) {
  console.log(`\n== ${sym}  ${r.verdict}  @ ${r.price}  (bar closed ${r.last_closed_bar})`);
  console.log("   " + r.reasons.join(" | "));
  console.log(`   VWAP ${f(r.vwap, 4)}  20-bar range ${f(r.lo20, 4)} - ${f(r.hi20, 4)}  session ${f(r.session_low, 4)} - ${f(r.session_high, 4)}`);
  console.log(`   4h ${f(r.change_4h_pct)}%  24h ${f(r.change_24h_pct)}%  vs BTC 24h ${f(r.vs_btc_24h_pct)}%  ATR(15m) ${f(r.atr15m_pct, 3)}%  100x liq ${f(r.liq100_pct, 3)}% away`);
  console.log(`   long accounts ${f(r.long_accounts_pct, 1)}%  taker buy share 1h ${f(r.taker_buy_share_1h * 100, 1)}%  6h ${f(r.taker_buy_share_6h * 100, 1)}%`);
  r.last_events.forEach(e => console.log(`     ${e.time}  ${e.dir > 0 ? "UP  " : e.dir < 0 ? "DOWN" : "--  "} ${e.name}${e.level ? "  level " + e.level : ""}`));
}
