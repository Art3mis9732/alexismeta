"use strict";
/* Historical replay of ONE analyst's paper portfolio across BTC, ETH and XRP in time order, using the LIVE decision code (policies.decide), the LIVE risk gate and
 * sizing (risk.evaluate / sizePosition) and the live engine's exit and cost rules:
 *   entry  : ask (long) / bid (short) at the bar close, times (1 + side x 2 bps slippage), taker fee 6 bps on both legs
 *   stop   : first trade through the stop; filled at the WORSE of the stop and the observed price, then 2 bps slippage. Here the observed price comes from 1m candles:
 *            a candle that touches the stop fills at the stop, or at its open when it opened beyond the stop (a gap)
 *   target : filled at the target, then 2 bps slippage; time exit: the first 1m open at/after the exit time, then slippage
 *   both stop and target touched inside ONE 1m candle: the STOP is assumed (conservative) and the trade is flagged `ambiguous`
 *   funding: booked from the public funding history at each settlement while open (-s x rate x qty x mark); outside the history it is unknown and counted, not assumed 0
 * The portfolio is coupled exactly as live: open-risk cap, 2x notional cap, one position per coin, cooldown, daily-loss and drawdown suspension, one account per analyst.
 * Not modelled (disclosed): queue position, partial fills, latency beyond the 3 s decision delay, depth impact, liquidation (the 2x cap keeps it far away). */
const risk = require("../server/risk"), { decide, RULES } = require("../server/policies");
const BAR = 900000, MIN = 60000, DAY = 86400000, ORDER = ["BTCUSDT", "ETHUSDT", "XRPUSDT"];

const { exitOnCandle } = require("../server/exit_rule");
function simulate({ analyst, snaps, m1, funding = {}, instruments, from = -Infinity, to = Infinity, config = risk.RISK_DEFAULTS, startEquity = 1000, gate = null, policy = decide, label = "", fixedSizing = false }) {
  const R = RULES[analyst], slip = config.slipFrac, taker = config.taker;
  const times = [...new Set(ORDER.flatMap(s => (snaps[s] || []).map(x => x.bar_close_ts)))].filter(t => t >= from && t <= to).sort((a, b) => a - b);
  const snapAt = {}, ptr = {}; for (const s of ORDER) { snapAt[s] = new Map((snaps[s] || []).map(x => [x.bar_close_ts, x])); ptr[s] = 0; }
  const closeAt = {}; for (const s of ORDER) closeAt[s] = new Map((snaps[s] || []).map(x => [x.bar_close_ts, x.close]));
  let cash = startEquity, peak = startEquity, dayStart = null, dayEq = startEquity, open = [], trades = [], curve = [], seq = 0;
  const lastExit = {}, counts = {}, bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const markOf = (sym, t) => { const c = closeAt[sym].get(t); return c === undefined ? null : c; };
  const unreal = (t) => open.reduce((a, p) => a + p.side * (((markOf(p.sym, t) ?? p.last_mark) - p.entry)) * p.qty, 0);

  function fundingFor(p, exitTs) {
    const F = funding[p.sym]; if (!F) return { amount: 0, unknown: true };
    if (F.length === 0 || exitTs < F[0][0] || p.opened_ts > F[F.length - 1][0] + 8 * 3600000) return { amount: 0, unknown: true };
    let amt = 0; for (const [ts, rate] of F) if (ts > p.opened_ts && ts <= exitTs) { const mk = markNear(p.sym, ts); amt += -p.side * rate * p.qty * (mk ?? p.entry); }
    return { amount: amt, unknown: false };
  }
  const m1Index = {}; for (const s of ORDER) if (m1[s]) { m1Index[s] = m1[s]; }
  function markNear(sym, ts) { const a = m1Index[sym]; if (!a) return null; let lo = 0, hi = a.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid].t <= ts) lo = mid; else hi = mid - 1; } return a[lo].c; }
  function startIdx(sym, ts) { const a = m1Index[sym]; let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < ts) lo = mid + 1; else hi = mid; } return lo; }

  function closePos(p, exitPx, ts, reason, extra = {}) {
    const exitFill = exitPx * (1 - p.side * slip), exitFee = p.qty * exitFill * taker, gross = p.side * (exitFill - p.entry) * p.qty, f = fundingFor(p, ts), net = gross - p.entry_fee - exitFee + f.amount;
    cash += gross - exitFee + f.amount;                                                      // the entry fee left cash at entry
    lastExit[p.sym] = ts; open = open.filter(x => x !== p);
    trades.push({ id: p.id, analyst, sym: p.sym, side: p.side, opened_ts: p.opened_ts, closed_ts: ts, entry: p.entry, exit: exitFill, qty: p.qty, stop: p.stop, target: p.target, risk_usdt: p.risk_usdt,
      gross, fees: p.entry_fee + exitFee, funding: f.amount, funding_unknown: f.unknown, net, R: p.risk_usdt > 0 ? net / p.risk_usdt : null, reason, ambiguous: !!extra.ambiguous, forced: !!extra.forced,
      slippage_cost: p.qty * (Math.abs(p.entry - p.ref) + Math.abs(exitFill - exitPx)), notional: p.qty * p.entry, bars_held: (ts - p.opened_ts) / BAR, trigger: p.trigger, trend: p.trend, atr_pctile: p.atr_pctile, change_24h: p.change_24h, hour: new Date(p.opened_ts).getUTCHours() });
  }
  function manage(t) {                                                                       // process 1m candles of every open position up to the bar close t
    for (const p of [...open]) {
      const a = m1Index[p.sym]; if (!a) continue;
      for (let k = p.idx; k < a.length && a[k].t + MIN <= t; k++) {
        const c = a[k]; p.idx = k + 1; p.last_mark = c.c;
        const x = exitOnCandle(p, c); if (x) { closePos(p, x.px, c.t, x.reason, x.ambiguous ? { ambiguous: true } : {}); break; }
      }
    }
  }
  for (const t of times) {
    manage(t);
    const day = Math.floor(t / DAY) * DAY, eqBefore = cash + unreal(t);
    if (dayStart !== day) { dayStart = day; dayEq = eqBefore; }
    peak = Math.max(peak, eqBefore);
    for (const sym of ORDER) {
      const snap = snapAt[sym].get(t); if (!snap) continue;
      const openHere = open.some(p => p.sym === sym), cool = lastExit[sym] !== undefined ? Math.floor(lastExit[sym] / BAR) * BAR + (R.cooldownBars + 1) * BAR : null;
      const d = policy(analyst, snap, { position_open: openHere, cooldown_until: cool }); bump("decision:" + d.code);
      if (d.intent !== "OPEN_LONG" && d.intent !== "OPEN_SHORT") continue;
      bump("setup"); bump("setup:" + sym);
      if (gate) { const g = gate(sym, t, open); if (g && g.block) { bump("blocked_by_gate"); bump("gate:" + g.reason); continue; } }
      const pf = { analyst, equity: fixedSizing ? startEquity : cash, peak_equity: fixedSizing ? startEquity : peak, day: { start_ts: dayStart, start_equity: fixedSizing ? startEquity : dayEq }, kill_switch: false,
        positions: open.map(p => ({ instrument_id: "bitget:perp:" + p.sym, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, mark: markOf(p.sym, t) ?? p.last_mark })) };
      const g = risk.evaluate({ analyst, setup: { intent: d.intent, stop: d.setup.stop }, snapshot: snap, portfolio: pf, instrument: instruments[sym], config });
      if (!g.approved) { for (const r of g.reasons) bump("risk_reject:" + r); continue; }
      const side = d.intent === "OPEN_LONG" ? 1 : -1, fill = g.entry_reference * (1 + side * slip), qty = Number(g.size.qty_str), fee = qty * fill * taker;
      cash -= fee; bump("opened");
      open.push({ id: `${label}${analyst}:${sym}:${t}:${++seq}`, sym, side, qty, entry: fill, ref: g.entry_reference, stop: d.setup.stop, target: d.setup.target, time_exit_ts: d.setup.time_exit_ts, opened_ts: t + 3000, entry_fee: fee,
        risk_usdt: g.size.risk_usdt, idx: startIdx(sym, t), last_mark: fill, trigger: d.setup.trigger, trend: snap.trend_1h, atr_pctile: snap.atr_pctile, change_24h: snap.change_24h });
    }
    curve.push({ ts: t, equity: cash + unreal(t), open: open.length });
  }
  const tEnd = times[times.length - 1];
  for (const p of [...open]) closePos(p, markOf(p.sym, tEnd) ?? p.last_mark, tEnd, "end_of_data", { forced: true });
  return { analyst, trades, curve, counts, min_equity: Math.min(startEquity, ...curve.map(c => c.equity)), fixed_sizing: !!fixedSizing, start_equity: startEquity, end_cash: cash, from: times[0], to: tEnd, bars: times.length };
}
module.exports = { simulate, exitOnCandle, ORDER, BAR, DAY };
