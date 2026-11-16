"use strict";
/* Canonical PAPER accounting and valuation (valuation-v1). Pure functions; the engine and every API view use these.
 * Scope: LINEAR USDT-margined perpetuals only. Anything else is rejected, never valued with the linear formula.
 *
 * Symbols:  s = +1 long / -1 short;  q = remaining BASE quantity (= contracts x contract multiplier);
 *           e = average entry fill price of the remaining quantity;  m = exchange mark price;
 *           x = estimated executable close price for the WHOLE remaining quantity (depth-weighted).
 *
 *   U_mark                       = s * q * (m - e)                         gross mark-to-market, no costs
 *   remaining close contribution = s * q * (x - e) - estimated exit fee    x from bid depth (long) / ask depth (short)
 *   lifecycle if closed now      = realized gross (prior exits) + remaining close contribution
 *                                  - entry fees paid - prior exit fees paid + settled funding (signed cashflows)
 *   cash balance                 = start + external cashflows + realized gross - booked fees + settled funding
 *   mark equity                  = cash balance + sum(U_mark)
 *   reserved margin (simulator)  = sum(q * e) / leverage setting      collateral reservation, NOT an expense
 *   available balance            = cash balance - reserved margin     (isolated-style: open profit is not spendable)
 * These are the SIMULATOR's conventions. They are not claimed to equal a Bitget account statement.
 *
 * Average cost: entries change e (quantity-weighted); exits realise s * q_exit * (p - e) and leave e unchanged.
 * Entry fees are allocated to closed/open portions pro rata by quantity; the two parts always sum to the fees paid.
 * Funding cashflow at a settlement = -s * rate * q * mark  (a long PAYS when the rate is positive).
 * Leverage never multiplies P&L: for a fixed quantity it only changes the margin denominator.
 * Precision: quantities are exact integers of 1e-8 base units; money is IEEE double, compared with 1e-9 tolerance and
 * rounded only for display. */

const VALUATION_VERSION = "valuation-v1";
const QTY_SCALE = 100000000n;                      // 1e-8 base units

function toUnits(dec) {
  const s = String(dec).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("accounting: bad quantity " + dec);
  const [a, b = ""] = s.split(".");
  if (b.length > 8) throw new Error("accounting: quantity finer than 1e-8 " + dec);
  return BigInt(a) * QTY_SCALE + BigInt((b + "00000000").slice(0, 8));
}
const fromUnits = u => Number(u) / 1e8;
const okPrice = p => typeof p === "number" && Number.isFinite(p) && p > 0;

/** Base quantity (1e-8 units) for a number of contracts. Rejects unsupported contract types. */
function baseUnits(contracts, instrument) {
  if (!instrument || Number(instrument.linear) !== 1) throw new Error("UNSUPPORTED_CONTRACT: only linear contracts are valued");
  if (instrument.settle && instrument.settle !== "USDT") throw new Error("UNSUPPORTED_CONTRACT: settle asset " + instrument.settle);
  const mult = toUnits(instrument.multiplier === undefined ? "1" : instrument.multiplier);
  if (mult <= 0n) throw new Error("UNSUPPORTED_CONTRACT: multiplier must be positive");
  return toUnits(contracts) * mult / QTY_SCALE;
}

/** Position state from its fills (deduplicated by fill_id, applied in time order).
 *  fill = { fill_id, ts, kind: "ENTRY"|"EXIT", qty (contracts, decimal string), price, fee } */
function positionFromFills(side, fills, instrument) {
  if (side !== 1 && side !== -1) throw new Error("accounting: side must be +1 or -1");
  const seen = new Set(), list = [];
  for (const f of fills) { if (seen.has(f.fill_id)) continue; seen.add(f.fill_id); list.push(f); }
  list.sort((a, b) => a.ts - b.ts || String(a.fill_id).localeCompare(String(b.fill_id)));
  let rem = 0n, entered = 0n, cost = 0, avg = null, realized = 0, entryFees = 0, exitFees = 0, exits = 0;
  for (const f of list) {
    if (!okPrice(f.price) || !(f.fee >= 0)) throw new Error("accounting: invalid fill " + f.fill_id);
    const u = baseUnits(f.qty, instrument); if (u <= 0n) throw new Error("accounting: zero-quantity fill " + f.fill_id);
    if (f.kind === "ENTRY") { cost = (avg === null ? 0 : avg * fromUnits(rem)) + f.price * fromUnits(u); rem += u; entered += u; avg = cost / fromUnits(rem); entryFees += f.fee; }
    else if (f.kind === "EXIT") {
      if (u > rem) throw new Error("accounting: exit larger than the remaining quantity in " + f.fill_id);
      realized += side * fromUnits(u) * (f.price - avg); rem -= u; exitFees += f.fee; exits++;
    } else throw new Error("accounting: unknown fill kind " + f.kind);
  }
  const q = fromUnits(rem), qEntered = fromUnits(entered), closedShare = entered > 0n ? Number(entered - rem) / Number(entered) : 0;
  return { side, entry_qty: qEntered, remaining_qty: q, remaining_units: rem, avg_entry: avg, realized_gross: realized,
    entry_fees: entryFees, exit_fees: exitFees, entry_fees_closed: entryFees * closedShare, entry_fees_open: entryFees * (1 - closedShare),
    fills: list.length, state: entered === 0n ? "EMPTY" : rem === 0n ? "CLOSED" : exits > 0 ? "PARTIAL" : "OPEN" };
}

/** Gross mark-to-market unrealised P&L, or null when the mark is not a valid price. */
function markUnrealized(pos, mark) { return okPrice(mark) && pos.avg_entry !== null ? pos.side * pos.remaining_qty * (mark - pos.avg_entry) : null; }

/** Depth-weighted close estimate for the whole remaining quantity. book = { bids: [[price, baseQty]...] desc, asks: [...] asc }.
 *  extraSlipFrac models latency/adverse drift ON TOP of the depth walk; default 0 so slippage is not counted twice. */
function closeEstimate(pos, book, { feeRate, extraSlipFrac = 0 } = {}) {
  if (!(feeRate >= 0)) throw new Error("accounting: feeRate required");
  if (pos.remaining_qty === 0) return { status: "FLAT", coverage: 1, x: null, exit_fee_est: 0, remaining_close_contribution: 0 };
  const side = pos.side > 0 ? "bids" : "asks", levels = book && Array.isArray(book[side]) ? book[side] : null;
  if (!levels || !levels.length) return { status: "UNAVAILABLE", coverage: 0, x: null, exit_fee_est: null, remaining_close_contribution: null };
  let need = pos.remaining_qty, got = 0, value = 0, used = 0;
  for (const [p, s] of levels) {
    const price = Number(p), size = Number(s);
    if (!okPrice(price) || !(size > 0)) continue;
    const take = Math.min(size, need - got); value += take * price; got += take; used++;
    if (need - got <= 1e-12) break;
  }
  const coverage = Math.min(1, got / need);
  if (coverage < 1 - 1e-9) return { status: "PARTIAL_LIQUIDITY", coverage, x: null, x_for_covered_part: got > 0 ? value / got : null, exit_fee_est: null,
    remaining_close_contribution: null, levels_used: used };
  const x = (value / got) * (1 - pos.side * extraSlipFrac), fee = pos.remaining_qty * x * feeRate;
  return { status: "OK", coverage: 1, x, exit_fee_est: fee, remaining_close_contribution: pos.side * pos.remaining_qty * (x - pos.avg_entry) - fee, levels_used: used,
    slippage_model: extraSlipFrac ? `depth walk + ${extraSlipFrac * 1e4} bps` : "depth walk only" };
}

/** Whole-position estimate if the remainder were closed now. An ESTIMATE, not a fill. null when no close estimate exists. */
function lifecycleIfClosedNow(pos, closeEst, settledFunding = 0) {
  if (!closeEst || (closeEst.status !== "OK" && closeEst.status !== "FLAT")) return null;
  return pos.realized_gross + closeEst.remaining_close_contribution - pos.entry_fees - pos.exit_fees + settledFunding;
}

/** Signed funding cashflow for one settlement. */
function fundingCashflow(side, baseQty, rate, mark) {
  if (!okPrice(mark) || !Number.isFinite(rate)) return null;
  return -side * rate * baseQty * mark;
}

/** Account view. positions = [{ pos (from positionFromFills), funding (settled, signed), u_mark (number|null) }] */
function accountView({ start, external = 0, positions, leverage }) {
  let realized = 0, fees = 0, funding = 0, u = 0, uUnknown = 0, reserved = 0, openNotional = 0;
  for (const p of positions) {
    realized += p.pos.realized_gross; fees += p.pos.entry_fees + p.pos.exit_fees; funding += p.funding || 0;
    if (p.pos.remaining_qty > 0) {
      const n = p.pos.remaining_qty * p.pos.avg_entry; openNotional += n; reserved += leverage > 0 ? n / leverage : n;
      if (typeof p.u_mark === "number") u += p.u_mark; else uUnknown++;
    }
  }
  const cash = start + external + realized - fees + funding;
  return { starting_capital: start, external_cashflows: external, realized_gross: realized, fees_booked: fees, funding_settled: funding,
    realized_net: realized - fees + funding, cash_balance: cash, unrealized_mark: uUnknown ? null : u, unrealized_mark_partial: u, positions_without_mark: uUnknown,
    mark_equity: uUnknown ? null : cash + u, reserved_margin: reserved, available_balance: cash - reserved, open_entry_notional: openNotional,
    margin_model: `simulator: reserved = entry notional / ${leverage}; unrealised profit is not spendable; not an exchange statement` };
}

/** Labelled percentages. Every key names its denominator; null when the denominator is unavailable. */
function percentages(pos, uMark, lifecycle, leverage) {
  const notional = pos.remaining_qty * (pos.avg_entry || 0), entryNotional = pos.entry_qty * (pos.avg_entry || 0);
  const im = leverage > 0 ? notional / leverage : null, im0 = leverage > 0 ? entryNotional / leverage : null;
  return {
    gross_unrealized_pct_of_entry_notional: uMark !== null && notional > 0 ? uMark / notional * 100 : null,
    gross_unrealized_pct_of_initial_margin: uMark !== null && im > 0 ? uMark / im * 100 : null,
    net_lifecycle_pct_of_initial_margin_of_full_entry: lifecycle !== null && im0 > 0 ? lifecycle / im0 * 100 : null
  };
}

/** Full valuation of one open position with freshness. Stale inputs are reported, never silently used as fresh. */
function valuePosition({ pos, mark, book, now, feeRate, leverage, settledFunding = 0, staleMs = { mark: 10000, book: 10000 } }) {
  const quality = [];
  const mAge = mark && mark.ts ? now - mark.ts : null, bAge = book && book.ts ? now - book.ts : null;
  const mStatus = !mark || !okPrice(mark.price) ? "UNAVAILABLE" : mAge > staleMs.mark ? "STALE" : "OK";
  const bStatus = !book || book.state !== "VALID" ? "UNAVAILABLE" : bAge > staleMs.book ? "STALE" : "OK";
  if (mStatus !== "OK") quality.push("mark_" + mStatus.toLowerCase());
  if (bStatus !== "OK") quality.push("book_" + bStatus.toLowerCase());
  const u = mStatus === "UNAVAILABLE" ? null : markUnrealized(pos, mark.price);
  const ce = bStatus === "UNAVAILABLE" ? { status: "UNAVAILABLE", coverage: 0, x: null, exit_fee_est: null, remaining_close_contribution: null } : closeEstimate(pos, book, { feeRate });
  if (ce.status === "PARTIAL_LIQUIDITY") quality.push("insufficient_close_depth");
  const life = lifecycleIfClosedNow(pos, ce, settledFunding);
  return { valuation_method: VALUATION_VERSION, calc_ts: now,
    mark: { price: mark && okPrice(mark.price) ? mark.price : null, ts: mark ? mark.ts || null : null, age_ms: mAge, status: mStatus },
    book: { ts: book ? book.ts || null : null, age_ms: bAge, status: bStatus },
    u_mark: u, u_mark_is_stale: mStatus === "STALE", close_now: { ...ce, is_stale: bStatus === "STALE" }, lifecycle_if_closed_now: life,
    pct: percentages(pos, u, life, leverage), quality };
}

module.exports = { VALUATION_VERSION, toUnits, fromUnits, baseUnits, positionFromFills, markUnrealized, closeEstimate, lifecycleIfClosedNow, fundingCashflow,
  accountView, percentages, valuePosition };
