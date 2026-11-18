"use strict";
/* Research data layer. Loads the PUBLIC Bitget history downloaded by research/fetch_native.js and scripts/stress_fetch_1m.js (data/hist, gitignored).
 * Nothing here talks to the network or to any database. Rows use the same field names the live evidence builder consumes. */
const fs = require("node:fs"), path = require("node:path");
const HIST = process.env.ALEXIS_HIST_DIR || path.join(__dirname, "..", "data", "hist");
const BAR = 900000, MIN = 60000;
const SYMS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"], ID = s => "bitget:perp:" + s;
const readJson = f => JSON.parse(fs.readFileSync(path.join(HIST, f), "utf8"));

/** Exchange-native 15m bars as evidence rows {open_ts, o, h, l, c, base_vol, final}. Only complete, contiguous history is assumed; gaps are reported by gapsOf(). */
function loadNative15(sym) { return readJson(`15m_${sym}.json`).map(r => ({ open_ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], base_vol: r[5], final: 1 })); }
/** 1m candles as compact numeric rows {t, o, h, l, c, v} (open time, OHLC, base volume). Used only to resolve stop/target ORDER inside a bar. */
function load1m(sym) { return readJson(`1m_${sym}.json`).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })); }
/** Funding history [[fundingTime, rate]] ascending, or null when absent. */
function loadFunding(sym) { try { return readJson(`funding_${sym}.json`).map(r => [r[0], Number(r[1])]); } catch (e) { return null; } }
function gapsOf(rows, step, key = "open_ts") { const g = []; for (let i = 1; i < rows.length; i++) if (rows[i][key] - rows[i - 1][key] !== step) g.push({ after: rows[i - 1][key], before: rows[i][key] }); return g; }
/** Aggregate 1m rows to 15m evidence rows; only buckets with all 15 minutes are kept (so a partial bucket never becomes a bar). */
function aggregate15(rows1m) {
  const B = new Map();
  for (const r of rows1m) { const k = Math.floor(r.t / BAR) * BAR; let b = B.get(k); if (!b) { b = { open_ts: k, o: r.o, h: -Infinity, l: Infinity, c: r.c, base_vol: 0, final: 1, n: 0 }; B.set(k, b); } b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; b.base_vol += r.v; b.n++; }
  return [...B.values()].filter(b => b.n === 15).sort((a, b) => a.open_ts - b.open_ts).map(({ n, ...x }) => x);
}
/** Compare native and aggregated bars on their overlap: how many bars differ in OHLC beyond a tolerance, and the largest volume difference. */
function compareBars(native, agg, tol = 1e-9) {
  const m = new Map(agg.map(b => [b.open_ts, b])); let n = 0, diffOhlc = 0, maxVolRel = 0, maxPx = 0;
  for (const b of native) { const a = m.get(b.open_ts); if (!a) continue; n++;
    const d = Math.max(Math.abs(+b.o - a.o), Math.abs(+b.h - a.h), Math.abs(+b.l - a.l), Math.abs(+b.c - a.c)); maxPx = Math.max(maxPx, d); if (d > tol) diffOhlc++;
    const v = Math.abs(+b.base_vol - a.base_vol) / Math.max(1e-12, +b.base_vol); maxVolRel = Math.max(maxVolRel, v); }
  return { overlap_bars: n, bars_with_ohlc_difference: diffOhlc, max_abs_price_difference: maxPx, max_relative_volume_difference: maxVolRel };
}
module.exports = { HIST, BAR, MIN, SYMS, ID, loadNative15, load1m, loadFunding, gapsOf, aggregate15, compareBars };
