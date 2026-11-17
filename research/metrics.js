"use strict";
/* Performance statistics for simulated or recorded paper trades. Every figure is reported WITH its trade count; undefined values are null, never 0.
 * Uncertainty: a DAY-BLOCK bootstrap (resample whole UTC days with replacement). Three coins and three analysts trade the same bars and are strongly correlated, so
 * resampling single trades would overstate precision; the effective sample is closer to the number of independent days than the number of trades. */
const DAY = 86400000;
const sum = a => a.reduce((x, y) => x + y, 0), mean = a => (a.length ? sum(a) / a.length : null);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function quantile(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

function maxDrawdown(curve) { let peak = -Infinity, dd = 0, ddAt = null; for (const p of curve) { peak = Math.max(peak, p.equity); const d = p.equity / peak - 1; if (d < dd) { dd = d; ddAt = p.ts; } } return { max_drawdown_pct: curve.length ? dd * 100 : null, at_ts: ddAt }; }
/** trades: simulator trade records. `curve`: equity curve [{ts, equity}]. startEquity for returns. Forced (end-of-data) closes are excluded from the evaluable statistics and counted separately. */
function summarize(trades, { curve = null, startEquity = 1000, days = null } = {}) {
  const T = trades.filter(t => !t.forced), n = T.length, net = T.map(t => t.net), wins = T.filter(t => t.net > 0), losses = T.filter(t => t.net < 0);
  const gw = sum(wins.map(t => t.net)), gl = -sum(losses.map(t => t.net)), Rs = T.map(t => t.R).filter(x => x !== null && Number.isFinite(x));
  const notional = sum(T.map(t => t.notional)), heldBars = sum(T.map(t => t.bars_held));
  return { trades: n, forced_closes_excluded: trades.length - n, wins: wins.length, win_rate: n ? wins.length / n : null, net_usdt: n ? sum(net) : null, expectancy_usdt_per_trade: n ? mean(net) : null,
    expectancy_R_per_trade: Rs.length ? mean(Rs) : null, profit_factor: n && gl > 0 ? gw / gl : (n && gw > 0 ? null : null), gross_usdt: n ? sum(T.map(t => t.gross)) : null, fees_usdt: n ? sum(T.map(t => t.fees)) : null,
    funding_usdt: n ? sum(T.map(t => t.funding)) : null, slippage_cost_usdt: n ? sum(T.map(t => t.slippage_cost)) : null, trades_with_unknown_funding: T.filter(t => t.funding_unknown).length,
    ambiguous_stop_target_trades: T.filter(t => t.ambiguous).length, return_pct_of_start: n ? sum(net) / startEquity * 100 : null, turnover_notional_over_start: n ? notional / startEquity : null,
    avg_bars_held: n ? heldBars / n : null, ...(curve ? maxDrawdown(curve) : {}), ...(days ? { trades_per_day: n / days } : {}) };
}
function groupBy(trades, keyFn) { const m = {}; for (const t of trades) { const k = keyFn(t); (m[k] = m[k] || []).push(t); } return m; }
const bucket = (v, a, b) => (v === null || v === undefined ? "unknown" : v <= a ? "low" : v <= b ? "mid" : "high");
function breakdowns(trades, opts) {
  const T = trades.filter(t => !t.forced), by = (fn) => Object.fromEntries(Object.entries(groupBy(T, fn)).map(([k, v]) => [k, summarize(v, opts)])), pick = s => ({ trades: s.trades, net_usdt: s.net_usdt, win_rate: s.win_rate, expectancy_R_per_trade: s.expectancy_R_per_trade, profit_factor: s.profit_factor });
  const slim = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, pick(v)]));
  return { by_asset: slim(by(t => t.sym)), by_direction: slim(by(t => (t.side > 0 ? "LONG" : "SHORT"))), by_exit: slim(by(t => t.reason)), by_trigger: slim(by(t => t.trigger)),
    by_trend_1h: slim(by(t => (t.trend > 0 ? "up" : t.trend < 0 ? "down" : "flat"))), by_volatility_regime: slim(by(t => bucket(t.atr_pctile, 0.33, 0.66))), by_session_utc: slim(by(t => (t.hour < 8 ? "00-08" : t.hour < 16 ? "08-16" : "16-24"))) };
}
/** Day-block bootstrap of total net and mean net per trade. Returns percentile CIs. B resamples of the SET OF DAYS in [from, to]. */
function dayBootstrap(trades, { from, to, B = 2000, seed = 1 } = {}) {
  const T = trades.filter(t => !t.forced), d0 = Math.floor(from / DAY), d1 = Math.floor(to / DAY), nd = d1 - d0 + 1, perDay = new Array(nd).fill(0), cnt = new Array(nd).fill(0);
  for (const t of T) { const k = Math.floor(t.closed_ts / DAY) - d0; if (k >= 0 && k < nd) { perDay[k] += t.net; cnt[k]++; } }
  const r = rng(seed), tot = [], per = [];
  for (let b = 0; b < B; b++) { let s = 0, c = 0; for (let i = 0; i < nd; i++) { const k = Math.floor(r() * nd); s += perDay[k]; c += cnt[k]; } tot.push(s); per.push(c ? s / c : null); }
  const per2 = per.filter(x => x !== null);
  return { days: nd, days_with_trades: cnt.filter(c => c > 0).length, total_net_ci95: [quantile(tot, 0.025), quantile(tot, 0.975)], mean_net_per_trade_ci95: per2.length ? [quantile(per2, 0.025), quantile(per2, 0.975)] : null,
    share_of_resamples_with_positive_total: tot.filter(x => x > 0).length / tot.length, note: "resamples whole UTC days; the three coins and three analysts on the same bars are not independent observations" };
}
module.exports = { summarize, breakdowns, dayBootstrap, maxDrawdown, rng, quantile, mean, sum, DAY };
