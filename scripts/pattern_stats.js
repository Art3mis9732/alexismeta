/* Measure what actually happened after every pattern on real Bitget 15m history.
 *   node scripts/pattern_stats.js            (reads data/hist/<SYM>_15m.json, writes docs/data/stats.json)
 *
 * For every directional event at bar i:
 *   entry  = OPEN of bar i+1 (the first price you could really get after seeing the pattern)
 *   hit4 / hit16 = was the close 1h / 4h later on the pattern's side of the entry?
 *   liq100 = did price move against you by the 100x liquidation distance within 4h?
 *   trade  = stop at the pattern's own invalidation, target 1.5 x risk ([V] minimum reward:risk),
 *            32-bar (8h) time-out; stop wins if stop and target are both inside one candle;
 *            costs = taker fee both sides + 1 bp slippage each side.
 * The timeline is split 70% / 30% in time order so you can see whether a result held up later.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Pt = require("../docs/patterns.js");

const ROOT = path.resolve(__dirname, "..");
const HIST = process.argv[2] || path.join(ROOT, "data", "hist");
const OUT = process.argv[3] || path.join(ROOT, "docs", "data", "stats.json");
const TAKER = 0.0006, SLIP = 0.0001, MMR = 0.004;
const COST = 2 * TAKER + 2 * SLIP;                 // round trip, as a fraction of notional
const LIQ100 = Pt.liqDistance(100, MMR, TAKER);
const RR = 1.5, HOLD = 32, SPLIT = 0.7, MIN_STOP_ATR = 0.5;
const TRIG = { BO_UP: 1, RETEST_UP: 1, VWAP_PB_UP: 1, BO_DN: 1, RETEST_DN: 1, VWAP_PB_DN: 1 };

function evalEvent(c, e) {
  const i = e.i, d = e.dir, n = c.length;
  if (!d || i + HOLD >= n) return null;
  const entry = c[i + 1].o;
  const o = { hit4: d * (c[i + 4].c - entry) > 0, hit16: d * (c[i + 16].c - entry) > 0,
              ret16: d * (c[i + 16].c / entry - 1) * 1e4 };
  let adverse = 0;
  for (let j = i + 1; j <= i + 16; j++) adverse = Math.max(adverse, d === 1 ? (entry - c[j].l) / entry : (c[j].h - entry) / entry);
  o.liq100 = adverse >= LIQ100;
  if (e.stop === null || !e.atr) { o.trade = false; return o; }
  // [A] the pattern's own stop, but never closer than 0.5 ATR to the entry (a hanging man closes
  // right under its high, so the textbook stop would be a few ticks away and fees would swamp it)
  const risk = Math.max(d * (entry - e.stop), MIN_STOP_ATR * e.atr);
  const stop = entry - d * risk;
  const target = entry + d * RR * risk;
  let R = null;
  for (let j = i + 1; j <= i + HOLD; j++) {
    const stopHit = d === 1 ? c[j].l <= stop : c[j].h >= stop;
    const tgtHit = d === 1 ? c[j].h >= target : c[j].l <= target;
    if (stopHit) {
      const gap = j > i + 1 && (d === 1 ? c[j].o < stop : c[j].o > stop);
      R = gap ? d * (c[j].o - entry) / risk : -1; break;
    }
    if (tgtHit) { R = RR; break; }
  }
  if (R === null) R = d * (c[i + HOLD].c - entry) / risk;
  o.trade = true; o.grossR = R; o.riskPct = risk / entry; o.netR = R - COST / o.riskPct;
  return o;
}

function agg(list) {
  const n = list.length;
  if (!n) return null;
  const tr = list.filter(x => x.trade);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const r3 = v => v === null ? null : Math.round(v * 1000) / 1000;
  const wins = tr.filter(x => x.netR > 0), losses = tr.filter(x => x.netR <= 0);
  let peak = 0, cum = 0, dd = 0;
  tr.forEach(x => { cum += x.netR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); });
  return {
    n, hit4: r3(mean(list.map(x => +x.hit4))), hit16: r3(mean(list.map(x => +x.hit16))),
    mean16_bps: r3(mean(list.map(x => x.ret16))), liq100: r3(mean(list.map(x => +x.liq100))),
    trades: tr.length, win_rate: r3(tr.length ? wins.length / tr.length : null),
    avg_win_R: r3(mean(wins.map(x => x.netR))), avg_loss_R: r3(mean(losses.map(x => x.netR))),
    exp_R_gross: r3(mean(tr.map(x => x.grossR))), exp_R_net: r3(mean(tr.map(x => x.netR))),
    avg_stop_pct: r3(mean(tr.map(x => x.riskPct * 100))), cost_in_R: r3(mean(tr.map(x => COST / x.riskPct))),
    max_drawdown_R: r3(dd)
  };
}

function run(sym, rows) {
  const c = rows.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const res = Pt.analyze(c);
  const cut = Math.floor(c.length * SPLIT);
  const buckets = {};
  const add = (key, part, o) => { ((buckets[key] = buckets[key] || { all: [], A: [], B: [] })[part]).push(o); };
  const counts = {};
  res.events.forEach(e => {
    counts[e.code] = (counts[e.code] || 0) + 1;
    const o = evalEvent(c, e);
    if (!o) return;
    const part = e.i < cut ? "A" : "B";
    const keys = [e.code];
    if (e.trend === e.dir) keys.push(e.code + "|T");
    if (TRIG[e.code] && e.trend === e.dir && (e.dir === 1) === e.above) keys.push(e.dir === 1 ? "SETUP_LONG" : "SETUP_SHORT", "SETUP_ANY");
    keys.forEach(k => { add(k, "all", o); add(k, part, o); });
  });
  const out = {};
  Object.keys(buckets).sort().forEach(k => {
    const a = agg(buckets[k].all), A = agg(buckets[k].A), B = agg(buckets[k].B);
    a.first70 = A ? { n: A.n, hit16: A.hit16, exp_R_net: A.exp_R_net } : null;
    a.last30 = B ? { n: B.n, hit16: B.hit16, exp_R_net: B.exp_R_net } : null;
    out[k] = a;
  });
  // Baseline: enter long (and short) at every 4th bar, no pattern at all.
  const base = { long: [], short: [] };
  for (let i = 60; i + HOLD < c.length; i += 4) {
    [1, -1].forEach(d => {
      const entry = c[i + 1].o; let adverse = 0;
      for (let j = i + 1; j <= i + 16; j++) adverse = Math.max(adverse, d === 1 ? (entry - c[j].l) / entry : (c[j].h - entry) / entry);
      base[d === 1 ? "long" : "short"].push({ hit16: d * (c[i + 16].c - entry) > 0, liq: adverse >= LIQ100 });
    });
  }
  const frac = (a, f) => a.length ? Math.round(a.filter(f).length / a.length * 1000) / 1000 : null;
  // Regime base rates: what price did over the next 4h given ONLY the 1h trend and the side of VWAP.
  const reg = { up: [], down: [], mixed: [] };
  for (let i = 250; i + 16 < c.length; i++) {
    const ab = c[i].c > res.vwap[i], t = res.trend[i], higher = c[i + 16].c > c[i].c;
    (t === 1 && ab ? reg.up : t === -1 && !ab ? reg.down : reg.mixed).push(higher);
  }
  const atrPct = res.atr.filter(x => x !== null).map((a, k) => a / c[k + Pt.PARAMS.atrLen - 1].c * 100).sort((x, y) => x - y);
  return {
    bars: c.length, from: new Date(c[0].t).toISOString(), to: new Date(c[c.length - 1].t + Pt.M15).toISOString(),
    split_at: new Date(c[cut].t).toISOString(), event_counts: counts, patterns: out,
    baseline: { n: base.long.length, long_hit16: frac(base.long, x => x.hit16), short_hit16: frac(base.short, x => x.hit16),
                long_liq100: frac(base.long, x => x.liq), short_liq100: frac(base.short, x => x.liq) },
    regime: { up: { n: reg.up.length, higher_4h_later: frac(reg.up, x => x) },
              down: { n: reg.down.length, lower_4h_later: frac(reg.down, x => !x) },
              mixed: { n: reg.mixed.length, higher_4h_later: frac(reg.mixed, x => x) } },
    median_atr15m_pct: Math.round(atrPct[Math.floor(atrPct.length / 2)] * 1000) / 1000
  };
}


/* ---------------- three trader profiles ----------------
 * One trade per signal: entry at the next candle's open, stop at the signal's invalidation
 * (never closer than minStopAtr x ATR), target rr x risk, stop wins if both are inside one candle,
 * gap through the stop fills at the open. Same costs as above. Results in R and in dollars for
 * $5 of margin at the profile's default leverage (liquidated if the stop is beyond liquidation). */
function tradeOut(c, i, d, stop, atrv, rr, minStopAtr, endIdx) {
  if (i + 1 > endIdx) return null;
  const entry = c[i + 1].o;
  let risk = d * (entry - stop);
  if (!(risk > 0)) return null;                          // price already through the stop
  if (minStopAtr && atrv) risk = Math.max(risk, minStopAtr * atrv);
  const sl = entry - d * risk, tp = entry + d * rr * risk;
  let exit = null, how = "time";
  for (let j = i + 1; j <= endIdx; j++) {
    const sh = d === 1 ? c[j].l <= sl : c[j].h >= sl, th = d === 1 ? c[j].h >= tp : c[j].l <= tp;
    if (sh) { exit = (j > i + 1 && (d === 1 ? c[j].o < sl : c[j].o > sl)) ? c[j].o : sl; how = "stop"; break; }
    if (th) { exit = tp; how = "target"; break; }
  }
  if (exit === null) exit = c[endIdx].c;
  const riskPct = risk / entry, grossR = d * (exit - entry) / risk;
  return { t: c[i].t, grossR, netR: grossR - COST / riskPct, riskPct, how, entry };
}
function profileAgg(list, cut, lev) {
  const liqD = Pt.liqDistance(lev, MMR, TAKER);
  const r3 = v => v === null || v === undefined || isNaN(v) ? null : Math.round(v * 1000) / 1000;
  const one = L => {
    if (!L.length) return { trades: 0 };
    const wins = L.filter(x => x.netR > 0), loss = L.filter(x => x.netR <= 0), mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    let cum = 0, peak = 0, dd = 0, streak = 0, worst = 0, usd = 0;
    L.forEach(x => {
      cum += x.netR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
      streak = x.netR <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
      const notional = 5 * lev;
      usd += x.riskPct >= liqD ? -5 : Math.max(-5, x.netR * x.riskPct * notional);   // $ result on $5 margin
    });
    return { trades: L.length, win_rate: r3(wins.length / L.length), avg_win_R: r3(mean(wins.map(x => x.netR))), avg_loss_R: r3(mean(loss.map(x => x.netR))),
      exp_R_gross: r3(mean(L.map(x => x.grossR))), exp_R_net: r3(mean(L.map(x => x.netR))), total_R: r3(cum), max_drawdown_R: r3(dd),
      longest_losing_streak: worst, avg_stop_pct: r3(mean(L.map(x => x.riskPct * 100))), cost_in_R: r3(mean(L.map(x => COST / x.riskPct))),
      liq_before_stop: r3(L.filter(x => x.riskPct >= liqD).length / L.length), usd_on_5: r3(usd),
      per_week: null };
  };
  const all = one(list);
  all.first70 = one(list.filter(x => x.t < cut)); all.last30 = one(list.filter(x => x.t >= cut));
  ["first70", "last30"].forEach(k => { const o = all[k]; all[k] = { trades: o.trades, win_rate: o.win_rate, exp_R_net: o.exp_R_net, total_R: o.total_R }; });
  return all;
}
function runProfiles(sym, c15, c5) {
  const out = {}, PR = Pt.PROFILES;
  const res = Pt.analyze(c15), cut = c15[Math.floor(c15.length * SPLIT)].t;
  const weeks = (c15[c15.length - 1].t - c15[0].t) / (7 * 86400000);
  const neutral = [], careful = [];
  res.events.forEach(e => {
    if (!Pt.isSetup(e)) return;
    const end = Math.min(c15.length - 1, e.i + HOLD);
    const a = tradeOut(c15, e.i, e.dir, e.stop, e.atr, PR.neutral.rr, PR.neutral.minStopAtr, end);
    if (a) neutral.push(a);
    if (Pt.carefulCheck(c15, res, e).ok) {
      const b = tradeOut(c15, e.i, e.dir, e.stop, e.atr, PR.careful.rr, PR.careful.minStopAtr, end);
      if (b) careful.push(b);
    }
  });
  out.neutral = profileAgg(neutral, cut, PR.neutral.lev);
  out.careful = profileAgg(careful, cut, PR.careful.lev);
  if (c5 && c5.length > 1000) {
    const rs = Pt.rangeScalp(c5), agg = [];
    rs.events.forEach(e => {
      const dayEnd = (Math.floor(c5[e.i].t / Pt.DAY) + 1) * Pt.DAY;
      let end = e.i; while (end + 1 < c5.length && c5[end + 1].t < dayEnd) end++;
      const a = tradeOut(c5, e.i, e.dir, e.stop, rs.atr[e.i], PR.aggressive.rr, PR.aggressive.minStopAtr, end);
      if (a) agg.push(a);
    });
    out.aggressive = profileAgg(agg, cut, PR.aggressive.lev);
    out.aggressive.signals = rs.events.length;
    out.aggressive.history = { bars5m: c5.length, from: new Date(c5[0].t).toISOString(), to: new Date(c5[c5.length - 1].t + 300000).toISOString() };
  } else out.aggressive = { trades: 0, note: "no 5-minute history" };
  ["aggressive", "neutral", "careful"].forEach(k => { if (out[k].trades) out[k].per_week = Math.round(out[k].trades / weeks * 10) / 10; out[k].default_leverage = PR[k].lev; out[k].rr = PR[k].rr; });
  return out;
}

function main() {
  const files = fs.readdirSync(HIST).filter(f => f.endsWith("_15m.json")).sort();
  const load = f => JSON.parse(fs.readFileSync(path.join(HIST, f), "utf8")).map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  if (!files.length) { console.error("no history files in " + HIST); process.exit(1); }
  const out = {
    generated_at_utc: new Date().toISOString().slice(0, 19).replace("T", " "),
    source: "Bitget public REST API v2, USDT-FUTURES perpetual, 15m trade-price candles",
    method: { entry: "open of the bar after the pattern", target_R: RR, max_hold_bars: HOLD, same_bar: "stop wins", min_stop_atr: MIN_STOP_ATR,
              cost_round_trip_pct: COST * 100, taker_fee_pct: TAKER * 100, slippage_bps_per_side: SLIP * 1e4,
              funding: "not included (most trades close within 8h; adds cost when held over a settlement)",
              liq100_distance_pct: Math.round(LIQ100 * 1e5) / 1e3, split: "first 70% / last 30% of the timeline",
              params: Pt.PARAMS },
    symbols: {}
  };
  files.forEach(f => {
    const sym = f.replace("_15m.json", "");
    out.symbols[sym] = run(sym, JSON.parse(fs.readFileSync(path.join(HIST, f), "utf8")));
    const s = out.symbols[sym];
    const f5 = sym + "_5m.json";
    s.profiles = runProfiles(sym, load(f), fs.existsSync(path.join(HIST, f5)) ? load(f5) : null);
    Object.entries(s.profiles).forEach(([k, v]) => console.log(`  PROFILE ${k.padEnd(10)} ${JSON.stringify(v)}`));
    console.log(`${sym}: ${s.bars} bars ${s.from} -> ${s.to}; baseline long_hit16=${s.baseline.long_hit16} liq100 long=${s.baseline.long_liq100}`);
    Object.entries(s.patterns).forEach(([k, v]) =>
      console.log(`  ${k.padEnd(16)} n=${String(v.n).padStart(5)} hit16=${v.hit16} expR_net=${v.exp_R_net} (gross ${v.exp_R_gross}, cost ${v.cost_in_R}R) last30: n=${v.last30 ? v.last30.n : 0} expR=${v.last30 ? v.last30.exp_R_net : null} liq100=${v.liq100}`));
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT);
}
main();
