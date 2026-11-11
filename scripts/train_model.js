/* Train and test a small prediction model, and test each indicator's classic signal.
 *   node scripts/train_model.js [histDir] [outFile]
 *
 * MODEL: logistic regression ("what are the odds price is higher 4 hours from now?") on the
 * features in docs/patterns.js (indicators, VWAP, trend, recent moves, patterns, time of day).
 *   1. Train on the first 70% of the timeline (all three coins together).
 *   2. Test ONCE on the last 30%, which the model never saw. These test numbers are what the site shows.
 *   3. Retrain on everything with the same settings for live use.
 * Labels overlap (each bar looks 16 bars ahead), so the test has fewer truly independent cases
 * than its row count suggests.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Pt = require("../docs/patterns.js");

const ROOT = path.resolve(__dirname, "..");
const HIST = process.argv[2] || path.join(ROOT, "data", "hist");
const OUT = process.argv[3] || path.join(ROOT, "docs", "data", "model.json");
const AHEAD = 16, SPLIT = 0.7, COST_BPS = 14, L2 = 1e-3, ITERS = 400, LR = 0.5, BAND = 0.05;

function load(sym) {
  return JSON.parse(fs.readFileSync(path.join(HIST, sym + "_15m.json"), "utf8"))
    .map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

function fit(X, y) {
  const n = X.length, d = X[0].length, mean = new Array(d).fill(0), std = new Array(d).fill(0);
  X.forEach(x => x.forEach((v, j) => mean[j] += v / n));
  X.forEach(x => x.forEach((v, j) => std[j] += (v - mean[j]) ** 2 / n));
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map(x => x.map((v, j) => (v - mean[j]) / std[j]));
  let w = new Array(d).fill(0), b = Math.log(y.reduce((a, v) => a + v, 0) / (n - y.reduce((a, v) => a + v, 0)));
  // Adam on the regularised log-loss (full batch)
  const mw = new Array(d).fill(0), vw = new Array(d).fill(0); let mb = 0, vb = 0;
  for (let it = 1; it <= ITERS; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      gb += e / n; for (let j = 0; j < d; j++) gw[j] += e * Z[i][j] / n;
    }
    for (let j = 0; j < d; j++) {
      const g = gw[j] + L2 * w[j];
      mw[j] = 0.9 * mw[j] + 0.1 * g; vw[j] = 0.999 * vw[j] + 0.001 * g * g;
      w[j] -= 0.01 * LR * (mw[j] / (1 - 0.9 ** it)) / (Math.sqrt(vw[j] / (1 - 0.999 ** it)) + 1e-8);
    }
    mb = 0.9 * mb + 0.1 * gb; vb = 0.999 * vb + 0.001 * gb * gb;
    b -= 0.01 * LR * (mb / (1 - 0.9 ** it)) / (Math.sqrt(vb / (1 - 0.999 ** it)) + 1e-8);
  }
  return { w, bias: b, mean, std };
}

function evaluate(model, rows, trainUpRate) {
  const r3 = v => Math.round(v * 1000) / 1000;
  let correct = 0, ll = 0, llBase = 0, up = 0;
  const buckets = [[0, 0.45], [0.45, 0.48], [0.48, 0.52], [0.52, 0.55], [0.55, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, up: 0 }));
  const trades = [];
  rows.forEach(r => {
    const p = Pt.predict(model, r.x), yv = r.y;
    up += yv; correct += (p > 0.5) === (yv === 1) ? 1 : 0;
    ll -= yv ? Math.log(p) : Math.log(1 - p);
    llBase -= yv ? Math.log(trainUpRate) : Math.log(1 - trainUpRate);
    const bk = buckets.find(b => p >= b.lo && p < b.hi); bk.n++; bk.up += yv;
    if (p > 0.5 + BAND) trades.push(r.ret - COST_BPS); else if (p < 0.5 - BAND) trades.push(-r.ret - COST_BPS);
  });
  const n = rows.length, upRate = up / n;
  return {
    rows: n, accuracy: r3(correct / n), up_rate: r3(upRate), coin_flip_best: r3(Math.max(upRate, 1 - upRate)),
    log_loss: r3(ll / n), log_loss_no_model: r3(llBase / n),
    buckets: buckets.map(b => ({ range: `${Math.round(b.lo * 100)}-${Math.min(100, Math.round(b.hi * 100))}%`, cases: b.n, actually_up: b.n ? r3(b.up / b.n) : null })),
    trade_rule: `long when the model says above ${50 + BAND * 100}%, short below ${50 - BAND * 100}%, hold 4h, ${COST_BPS} bps costs`,
    trades: trades.length, avg_net_bps: trades.length ? r3(trades.reduce((a, v) => a + v, 0) / trades.length) : null,
    win_rate: trades.length ? r3(trades.filter(v => v > 0).length / trades.length) : null
  };
}

/* Each indicator's textbook signal, held 4 hours, after costs. */
function indicatorSignals(c, res, ind) {
  const S = { RSI: [], MACD: [], Stochastic: [], Bollinger: [], ADX: [], EMA: [], OBV: [], VWAP: [] };
  for (let i = 60; i + AHEAD < c.length; i++) {
    const p = i - 1, x = (a, k) => a[k] !== null && a[k] !== undefined;
    const add = (k, d) => S[k].push({ i, d });
    if (x(ind.rsi, p) && x(ind.rsi, i)) { if (ind.rsi[p] < 30 && ind.rsi[i] >= 30) add("RSI", 1); if (ind.rsi[p] > 70 && ind.rsi[i] <= 70) add("RSI", -1); }
    if (x(ind.macdHist, p) && x(ind.macdHist, i)) { if (ind.macdHist[p] <= 0 && ind.macdHist[i] > 0) add("MACD", 1); if (ind.macdHist[p] >= 0 && ind.macdHist[i] < 0) add("MACD", -1); }
    if (x(ind.stochK, p) && x(ind.stochD, p) && x(ind.stochK, i) && x(ind.stochD, i)) {
      if (ind.stochK[p] <= ind.stochD[p] && ind.stochK[i] > ind.stochD[i] && ind.stochK[i] < 20) add("Stochastic", 1);
      if (ind.stochK[p] >= ind.stochD[p] && ind.stochK[i] < ind.stochD[i] && ind.stochK[i] > 80) add("Stochastic", -1); }
    if (x(ind.pctB, p) && x(ind.pctB, i)) { if (ind.pctB[p] < 0 && ind.pctB[i] >= 0) add("Bollinger", 1); if (ind.pctB[p] > 1 && ind.pctB[i] <= 1) add("Bollinger", -1); }
    if (x(ind.adx, i) && x(ind.plusDI, p) && x(ind.minusDI, p) && ind.adx[i] > 25) {
      if (ind.plusDI[p] <= ind.minusDI[p] && ind.plusDI[i] > ind.minusDI[i]) add("ADX", 1);
      if (ind.plusDI[p] >= ind.minusDI[p] && ind.plusDI[i] < ind.minusDI[i]) add("ADX", -1); }
    if (x(ind.ema20, p) && x(ind.ema50, p)) { if (ind.ema20[p] <= ind.ema50[p] && ind.ema20[i] > ind.ema50[i]) add("EMA", 1); if (ind.ema20[p] >= ind.ema50[p] && ind.ema20[i] < ind.ema50[i]) add("EMA", -1); }
    if (i >= 17) { const a = ind.obv[p] - ind.obv[p - 16], b = ind.obv[i] - ind.obv[i - 16]; if (a <= 0 && b > 0) add("OBV", 1); if (a >= 0 && b < 0) add("OBV", -1); }
    const dayStart = Math.floor(c[i].t / Pt.DAY) === Math.floor(c[p].t / Pt.DAY);
    if (dayStart) { if (c[p].c <= res.vwap[p] && c[i].c > res.vwap[i]) add("VWAP", 1); if (c[p].c >= res.vwap[p] && c[i].c < res.vwap[i]) add("VWAP", -1); }
  }
  return S;
}

function main() {
  const syms = fs.readdirSync(HIST).filter(f => f.endsWith("_15m.json")).map(f => f.replace("_15m.json", "")).sort();
  const data = {}, indRes = {};
  let tMin = Infinity, tMax = -Infinity;
  syms.forEach(s => {
    const c = load(s), res = Pt.analyze(c), ind = Pt.indicators(c), F = Pt.featureRows(c, res, ind), rows = [];
    for (let i = 0; i + AHEAD < c.length; i++) if (F[i]) rows.push({ t: c[i].t, x: F[i], y: c[i + AHEAD].c > c[i].c ? 1 : 0, ret: (c[i + AHEAD].c / c[i].c - 1) * 1e4, sym: s });
    data[s] = rows; indRes[s] = { c, res, ind };
    tMin = Math.min(tMin, c[0].t); tMax = Math.max(tMax, c[c.length - 1].t);
  });
  const cut = tMin + (tMax - tMin) * SPLIT;
  const all = syms.flatMap(s => data[s]), train = all.filter(r => r.t < cut - AHEAD * 900000), test = all.filter(r => r.t >= cut);
  const trainUp = train.reduce((a, r) => a + r.y, 0) / train.length;
  console.log(`train ${train.length} rows, test ${test.length} rows, split ${new Date(cut).toISOString()}`);
  const m1 = fit(train.map(r => r.x), train.map(r => r.y));
  const testAll = evaluate(m1, test, trainUp), testBy = {};
  syms.forEach(s => testBy[s] = evaluate(m1, test.filter(r => r.sym === s), trainUp));
  console.log("TEST (unseen):", JSON.stringify(testAll));
  const final = fit(all.map(r => r.x), all.map(r => r.y));
  const weights = Pt.FEATURES.map((f, j) => ({ feature: f, weight: Math.round(final.w[j] * 1000) / 1000 })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  console.log("weights:", weights.slice(0, 6).map(w => w.feature + " " + w.weight).join(" | "));

  // indicator report card
  const indOut = {};
  syms.forEach(s => {
    const { c, res, ind } = indRes[s], S = indicatorSignals(c, res, ind), o = {};
    Object.entries(S).forEach(([k, L]) => {
      const r = L.map(e => ({ t: c[e.i].t, net: e.d * (c[e.i + AHEAD].c / c[e.i + 1].o - 1) * 1e4 - COST_BPS, right: e.d * (c[e.i + AHEAD].c - c[e.i + 1].o) > 0 }));
      const agg = L2 => L2.length ? { n: L2.length, right_4h: Math.round(L2.filter(x => x.right).length / L2.length * 1000) / 1000,
        avg_net_bps: Math.round(L2.reduce((a, x) => a + x.net, 0) / L2.length * 10) / 10 } : { n: 0 };
      o[k] = Object.assign(agg(r), { first70: agg(r.filter(x => x.t < cut)), last30: agg(r.filter(x => x.t >= cut)) });
    });
    indOut[s] = o;
    console.log(s, Object.entries(o).map(([k, v]) => `${k} n=${v.n} right=${v.right_4h} net=${v.avg_net_bps}bps (later ${v.last30.avg_net_bps})`).join(" | "));
  });

  const out = {
    generated_at_utc: new Date().toISOString().slice(0, 19).replace("T", " "),
    what: "Chance that the price is higher 4 hours (16 x 15m candles) after the last closed candle",
    method: { type: "logistic regression", features: Pt.FEATURES, train_until: new Date(cut).toISOString(), l2: L2, iterations: ITERS,
      note: "Trained on the first 70% of 180 days of Bitget 15m candles (BTC, ETH, XRP together), tested once on the last 30%. Live model = same settings refit on all data." },
    model: { w: final.w, bias: final.bias, mean: final.mean, std: final.std },
    test: testAll, test_by_symbol: testBy, weights, indicators: indOut
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT);
}
main();
