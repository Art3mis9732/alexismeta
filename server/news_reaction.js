"use strict";
/* Observed price reaction since DISCOVERY of a news item. Display only: never an input to any decision.
 *
 * Reference price  = close of the last COMPLETE 1m candle that ended at or before the moment we discovered the item
 *                    (Bitget USDT-perp trade-price candles stored by the worker, final = 1).
 * Reaction at +h   = close of the 1m candle ending at discovery + h, relative to the reference price.
 * Not available (N/A, never zero) when:
 *   - the item was discovered in the source's FIRST poll (backlog): that time is when the worker started, not when the
 *     item appeared, so a reaction "since discovery" would be meaningless;
 *   - any required 1m candle is missing (outage, gap, retention), with the number of stored minutes reported;
 * PENDING while the horizon has not elapsed. A reaction is an observation of what the price did afterwards. It is NOT
 * evidence that the news caused it: other news and market moves overlap, and "already priced in" is not assessed. */

const HORIZONS = [["15m", 15 * 60000], ["1h", 3600000], ["4h", 4 * 3600000]];
const MIN = 60000;

function reaction(db, item, asset, now) {
  const base = { asset, method: "last complete 1m close before discovery vs the 1m close at +horizon (Bitget perpetual trade price)", causation: "observation only; not evidence the news caused the move" };
  if (item.backlog) return { ...base, horizons: HORIZONS.map(([h]) => ({ horizon: h, status: "NA", reason: "backlog item: discovered in the source's first poll, so discovery time is not when it appeared" })) };
  const id = `bitget:perp:${asset}USDT`, disc = item.discovered_ts, refOpen = Math.floor(disc / MIN) * MIN - MIN;
  const ref = db.prepare("SELECT c FROM candles WHERE instrument_id=? AND interval='1m' AND open_ts=? AND final=1").get(id, refOpen);
  const out = [];
  for (const [h, ms] of HORIZONS) {
    if (disc + ms > now - 2 * MIN) { out.push({ horizon: h, status: "PENDING", reason: "horizon has not elapsed yet" }); continue; }
    if (!ref) { out.push({ horizon: h, status: "NA", reason: "no complete 1m candle stored for the minute before discovery" }); continue; }
    const tOpen = Math.floor((disc + ms) / MIN) * MIN - MIN, need = (tOpen - refOpen) / MIN + 1;
    const rows = db.prepare("SELECT open_ts, c FROM candles WHERE instrument_id=? AND interval='1m' AND final=1 AND open_ts BETWEEN ? AND ? ORDER BY open_ts").all(id, refOpen, tOpen);
    if (rows.length !== need) { out.push({ horizon: h, status: "NA", reason: `candle gap: ${rows.length} of ${need} one-minute candles stored` }); continue; }
    const p0 = Number(ref.c), p1 = Number(rows[rows.length - 1].c);
    out.push({ horizon: h, status: "OK", pct: (p1 / p0 - 1) * 100, ref_price: p0, price: p1, from_ts: refOpen + MIN, to_ts: tOpen + MIN });
  }
  return { ...base, horizons: out };
}

/** Attach reactions for every tracked asset an item applies to. */
function withReaction(db, items, now, appliesTo) {
  return items.map(it => { const assets = appliesTo(it); return { ...it, reaction: assets.length ? assets.map(a => reaction(db, it, a, now)) : [] }; });
}

module.exports = { reaction, withReaction, HORIZONS };
