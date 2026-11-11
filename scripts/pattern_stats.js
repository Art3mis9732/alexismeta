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

function main() {
  const files = fs.readdirSync(HIST).filter(f => f.endsWith("_15m.json")).sort();
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
    console.log(`${sym}: ${s.bars} bars ${s.from} -> ${s.to}; baseline long_hit16=${s.baseline.long_hit16} liq100 long=${s.baseline.long_liq100}`);
    Object.entries(s.patterns).forEach(([k, v]) =>
      console.log(`  ${k.padEnd(16)} n=${String(v.n).padStart(5)} hit16=${v.hit16} expR_net=${v.exp_R_net} (gross ${v.exp_R_gross}, cost ${v.cost_in_R}R) last30: n=${v.last30 ? v.last30.n : 0} expR=${v.last30 ? v.last30.exp_R_net : null} liq100=${v.liq100}`));
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT);
}
main();
