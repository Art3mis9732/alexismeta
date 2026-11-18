"use strict";
/* Pre-registered dataset builder (research-prereg-v1, devdocs/research-preregistration.md).
 * Rows are (coin, 15m decision bar, side). Features come from the LIVE evidence builder (candle-only-v1 snapshot) plus candle statistics, all point-in-time.
 * The label is the net result of a fixed TEMPLATE trade (1.0 ATR stop, 1.5 ATR target, 32-bar time exit, taker 6 bps + slippage 2 bps per leg) resolved on 1m candles
 * with the same exit rule the replay uses (simulate.exitOnCandle). Nothing here fits a model.
 *   node research/dataset.js [--out data/research/dataset-v1]      writes split.json, manifest.json, rows.csv.gz */
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const H = require("./hist"), SN = require("./snapshots"), { exitOnCandle } = require("./simulate"), risk = require("../server/risk");
const BAR = H.BAR, MIN = H.MIN, DAY = 86400000, VERSION = "dataset-v1";
const TEMPLATE = Object.freeze({ stop_atr: 1.0, target_atr: 1.5, time_exit_bars: 32, taker: risk.RISK_DEFAULTS.taker, slip: risk.RISK_DEFAULTS.slipFrac });
const SPLIT = Object.freeze({ burn_in_days: 14, fractions: { train: 0.55, validation: 0.20, final: 0.25 }, embargo_days: 3 });
const FEATURES = ["trend", "vwap_side", "vwap_dist_atr", "atr_pct", "atr_pctile", "chg24h", "rv24h", "trig_with", "trig_against", "trig_bo_with", "trig_retest_with", "trig_vwap_with", "trig_fail_with",
  "ret1", "ret4", "ret16", "ret96", "range_pos", "vol_ratio", "hour_sin", "hour_cos"];
const fam = c => (c.startsWith("BO_") ? "bo" : c.startsWith("RETEST") ? "retest" : c.startsWith("VWAP_PB") ? "vwap" : c.startsWith("FAIL") ? "fail" : "other");

/** feature vector for side s (+1 long, -1 short) at bar index i of `rows`; only rows[0..i] and the snapshot (built from the same) are read. */
function features(snap, rows, i, s) {
  const c = k => +rows[i - k].c, atr = snap.atr, px = +rows[i].c, w = 96, lo = Math.min(...rows.slice(i - w + 1, i + 1).map(r => +r.l)), hi = Math.max(...rows.slice(i - w + 1, i + 1).map(r => +r.h));
  const vol = rows.slice(i - w + 1, i + 1).reduce((a, r) => a + +r.base_vol, 0) / w, hour = new Date(rows[i].open_ts + BAR).getUTCHours() + new Date(rows[i].open_ts + BAR).getUTCMinutes() / 60;
  const t = snap.triggers || [], withS = t.filter(x => x.dir === s), against = t.filter(x => x.dir === -s), nf = f => withS.filter(x => fam(x.code) === f).length;
  const pos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
  return [s * snap.trend_1h, s * (snap.above_vwap ? 1 : -1), s * (px - snap.vwap) / atr, snap.atr_pct, snap.atr_pctile, s * snap.change_24h, snap.rv_24h, withS.length, against.length, nf("bo"), nf("retest"), nf("vwap"), nf("fail"),
    s * (px - c(1)) / atr, s * (px - c(4)) / atr, s * (px - c(16)) / atr, s * (px - c(96)) / atr, s > 0 ? pos : 1 - pos, +rows[i].base_vol / (vol || 1), Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24)];
}
/** template-trade label for side s at the snapshot's bar close, resolved on 1m candles `a` (ascending, contiguous). Returns null when the label window is not fully covered by 1m data. */
function label(snap, a, startK, s, T = TEMPLATE) {
  const ref = s > 0 ? snap.ask : snap.bid, atr = snap.atr; if (!(ref > 0) || !(atr > 0)) return null;
  const entry = ref * (1 + s * T.slip), p = { side: s, stop: ref - s * T.stop_atr * atr, target: ref + s * T.target_atr * atr, time_exit_ts: snap.bar_close_ts + T.time_exit_bars * BAR };
  for (let k = startK; k < a.length; k++) {
    const c = a[k]; if (c.t < snap.bar_close_ts) continue;
    const x = exitOnCandle(p, c); if (!x) continue;
    const exit = x.px * (1 - s * T.slip), net = s * (exit - entry) - T.taker * (entry + exit);
    const costR = (s * (x.px - ref) - net) / (T.stop_atr * atr);                                          // everything between the frictionless result and the net: fees and slippage on both legs
    return { y: net > 0 ? 1 : 0, netR: net / (T.stop_atr * atr), costR, reason: x.reason, ambiguous: x.ambiguous ? 1 : 0, bars_held: (c.t - snap.bar_close_ts) / BAR, closed_ts: c.t };
  }
  return null;                                                                                          // data ended before the trade resolved
}
/** split boundaries by RULE from the first and last usable bar-close time (time order only). Returns {train:[a,b), validation:[a,b), final:[a,b)} with embargo gaps between them. */
function splitRule(firstTs, lastTs, S = SPLIT) {
  const a = firstTs + S.burn_in_days * DAY, span = lastTs - a, e = S.embargo_days * DAY, f = S.fractions;
  const trainEnd = a + span * f.train, valStart = trainEnd + e, valEnd = a + span * (f.train + f.validation), finalStart = valEnd + e;
  const iso = t => new Date(Math.round(t)).toISOString();
  return { rule: SPLIT, burn_in_end: iso(a), train: [a, trainEnd], validation: [valStart, valEnd], final: [finalStart, lastTs], iso: { train: [iso(a), iso(trainEnd)], validation: [iso(valStart), iso(valEnd)], final: [iso(finalStart), iso(lastTs)] } };
}
const splitOf = (ts, sp, horizon = TEMPLATE.time_exit_bars * BAR) => { for (const k of ["train", "validation", "final"]) { const [a, b] = sp[k]; if (ts >= a && ts + horizon < b + 1) return k; } return null; };   // label window must end inside the segment (purge)
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");

function build(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const per = {}, inputs = {}; let first = -Infinity, last = Infinity;
  for (const s of H.SYMS) { const nat = H.loadNative15(s), m1 = H.load1m(s); per[s] = { nat, m1 }; for (const f of [`15m_${s}.json`, `1m_${s}.json`]) inputs[f] = sha(fs.readFileSync(path.join(H.HIST, f)));
    first = Math.max(first, nat[0].open_ts + 300 * BAR, Math.ceil(m1[0].t / BAR) * BAR); last = Math.min(last, nat[nat.length - 1].open_ts + BAR - TEMPLATE.time_exit_bars * BAR, m1[m1.length - 1].t); }
  const sp = splitRule(first, last), lines = ["ts,coin,side,split," + FEATURES.join(",") + ",y,netR,costR,reason,ambiguous,bars_held"]; const counts = { rows: 0, dropped_no_label: 0, dropped_embargo_or_purge: 0, by_split: {} };
  const matrix = crypto.createHash("sha256");
  for (const sym of H.SYMS) {
    const { nat, m1 } = per[sym], idx = new Map(m1.map((c, k) => [c.t, k]));
    for (let i = 300; i < nat.length; i++) {
      const ts = nat[i].open_ts + BAR; if (ts < sp.train[0] || ts > last) continue;
      const split = splitOf(ts, sp); if (!split) { counts.dropped_embargo_or_purge += 2; continue; }
      const snap = SN.snapshotAt(sym, nat, i), k0 = idx.get(ts); if (k0 === undefined) { counts.dropped_no_label += 2; continue; }
      for (const s of [1, -1]) {
        const lb = label(snap, m1, k0, s); if (!lb) { counts.dropped_no_label++; continue; }
        const f = features(snap, nat, i, s), line = [ts, sym, s, split, ...f.map(v => +v.toPrecision(9)), lb.y, +lb.netR.toPrecision(9), +lb.costR.toPrecision(9), lb.reason, lb.ambiguous, lb.bars_held].join(",");
        lines.push(line); matrix.update(line + "\n"); counts.rows++; counts.by_split[split] = (counts.by_split[split] || 0) + 1;
      }
    }
  }
  fs.writeFileSync(path.join(outDir, "split.json"), JSON.stringify(sp, null, 1));
  fs.writeFileSync(path.join(outDir, "rows.csv.gz"), zlib.gzipSync(lines.join("\n") + "\n"));
  const manifest = { version: VERSION, built_at: new Date().toISOString(), template: TEMPLATE, split_rule: SPLIT, features: FEATURES, input_sha256: inputs, matrix_sha256: matrix.digest("hex"), counts,
    code_sha256: Object.fromEntries(["dataset.js", "snapshots.js", "simulate.js"].map(f => [f, sha(fs.readFileSync(path.join(__dirname, f)))])), variant: SN.VARIANT, microstructure_assumption: SN.MICRO };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1)); return { manifest, split: sp };
}
/** Build into `out`, except that the registered dataset-v1 can only be replaced by an IDENTICAL rebuild (same matrix hash); otherwise it is left untouched and an error is thrown. */
function placeBuild({ out, registered, buildFn }) {
  const guarded = registered && path.basename(out) === "dataset-v1", dir = guarded ? out + ".build" : out, r = buildFn(dir);
  if (guarded) {
    if (r.manifest.matrix_sha256 !== registered.matrix_sha256) { fs.rmSync(dir, { recursive: true, force: true }); throw Object.assign(new Error(`REFUSED: the rebuilt dataset (${r.manifest.matrix_sha256.slice(0, 12)}) differs from the registered one (${registered.matrix_sha256.slice(0, 12)}); dataset-v1 is left untouched. Use a new directory and a new pre-registration version.`), { refused: true }); }
    fs.rmSync(out, { recursive: true, force: true }); fs.renameSync(dir, out);
  }
  return r;
}
if (require.main === module) {
  // The registered dataset (research/registry/dataset-v1-manifest.json) can never be replaced by a different one: refreshed candles produce a DRAFT directory that needs its own pre-registration.
  const i = process.argv.indexOf("--out"), REGF = path.join(__dirname, "registry", "dataset-v1-manifest.json"), registered = fs.existsSync(REGF) ? JSON.parse(fs.readFileSync(REGF, "utf8")) : null;
  const base = path.join(__dirname, "..", "data", "research"), out = i >= 0 ? process.argv[i + 1] : path.join(base, registered ? "dataset-draft-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") : "dataset-v1");
  let r; try { r = placeBuild({ out, registered, buildFn: build }); } catch (e) { if (e.refused) { console.error(e.message); process.exit(2); } throw e; }
  console.log(JSON.stringify({ split: r.split.iso, counts: r.manifest.counts, matrix_sha256: r.manifest.matrix_sha256, written_to: out }, null, 1));
}
module.exports = { FEATURES, TEMPLATE, SPLIT, VERSION, features, label, splitRule, splitOf, build, placeBuild };
