"use strict";
/* news-overlay-v1: SHADOW assessment of what recent news would mean for a candidate paper entry. PURE: no database, no clock, no side effects.
 *
 * It can only ANNOTATE or SUBTRACT: it never creates, enlarges or reverses a trade, and in this version its output feeds nothing but the shadow record.
 * A headline's direction is never a signal by itself: a stance counts only together with an observed price move since the article was DISCOVERED, and the
 * move is an observation, not proof of cause. Point in time: only articles discovered at or before the decision, never backlog items, never later revisions.
 * Missing price data means "unverified" (no veto), never "no reaction". Article text is never executed or parsed here; only the stored stance/kind fields are read. */
const VERSION = "news-overlay-v1";
const WINDOW_MS = { risk_taker: 3600000, balanced: 2 * 3600000, defensive: 4 * 3600000 };        // how old an article may be and still matter, per analyst
const CONFIRM_BPS = 15;                                                                              // a move since discovery below this size is "no observable reaction"
const RANK = { WOULD_BLOCK: 5, WOULD_VETO: 4, CAUTION: 3, SUPPORTS: 2, NEUTRAL: 1, NO_RELEVANT_NEWS: 0 };

/** @param {{analyst:string, direction:1|-1, asset:string, decisionTs:number, items:object[], move:(item:object)=>({status:string,bps?:number})}} a */
function assess({ analyst, direction, asset, decisionTs, items, move }) {
  const win = WINDOW_MS[analyst]; if (!win) throw new Error("unknown analyst " + analyst);
  const used = [], notes = [];
  let verdict = "NO_RELEVANT_NEWS";
  const raise = (v) => { if (RANK[v] > RANK[verdict]) verdict = v; };
  for (const it of items || []) {
    if (!it || it.backlog || !(it.discovered_ts <= decisionTs)) continue;                          // not known at the decision time (or a first-poll backlog item)
    const age = decisionTs - it.discovered_ts; if (age > win) continue;
    const ip = (it.interpretations || []).find(x => x.asset === asset); if (!ip) continue;
    const m = typeof move === "function" ? move(it) : { status: "NA" };
    const ev = { item_id: it.item_id, title: String(it.title || "").slice(0, 160), source: it.source, discovered_ts: it.discovered_ts, age_min: Math.round(age / 60000), stance: ip.stance, kind: ip.kind, move_status: m.status, move_bps: m.status === "OK" ? +m.bps.toFixed(1) : null, effect: "NEUTRAL" };
    if (ip.kind === "operational_risk") {                                                           // venue incident: execution and data quality, not a direction
      ev.effect = "WOULD_BLOCK"; notes.push(`venue/operations notice within ${Math.round(age / 60000)} min: execution reliability uncertain`);
    } else if (ip.kind === "price_direction" && (ip.stance === "BULLISH" || ip.stance === "BEARISH")) {
      const bull = ip.stance === "BULLISH", opposed = bull ? direction < 0 : direction > 0;
      const confirmed = m.status === "OK" && (bull ? m.bps >= CONFIRM_BPS : m.bps <= -CONFIRM_BPS);
      if (opposed) {
        if (confirmed) { ev.effect = analyst === "risk_taker" ? "CAUTION" : "WOULD_VETO"; notes.push(`${ip.stance} news contradicts this ${direction > 0 ? "long" : "short"} and price moved ${ev.move_bps} bps with it since discovery`); }
        else if (m.status !== "OK") { ev.effect = analyst === "defensive" ? "CAUTION" : "NEUTRAL"; notes.push(`${ip.stance} news contradicts this entry; price reaction unverified (${m.status})`); }
        else { ev.effect = analyst === "defensive" ? "CAUTION" : "NEUTRAL"; notes.push(`${ip.stance} news contradicts this entry but no observable reaction (${ev.move_bps} bps): possibly already priced in`); }
      } else if (confirmed) { ev.effect = "SUPPORTS"; notes.push(`${ip.stance} news agrees with this entry and price moved ${ev.move_bps} bps with it; annotation only, no extra size`); }
    } else if ((ip.stance === "UNCERTAIN" || ip.stance === "MIXED") && ip.kind === "price_direction" && analyst === "defensive" && age <= 3600000) {
      ev.effect = "CAUTION"; notes.push("policy or macro event with unknown surprise within the last hour");
    }
    used.push(ev); raise(ev.effect);
  }
  return { version: VERSION, analyst, asset, direction, decision_ts: decisionTs, verdict, would_change_decision: verdict === "WOULD_BLOCK" || verdict === "WOULD_VETO",
    effect_on_decision: "NONE (shadow only)", window_min: win / 60000, confirm_bps: CONFIRM_BPS, evidence: used, reasons: notes };
}
module.exports = { VERSION, WINDOW_MS, CONFIRM_BPS, assess, RANK };
