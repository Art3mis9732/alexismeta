"use strict";
/* News interpretation, rule-based (news-rules-v1). A REPLACEABLE interface: an interpreter is a pure function
 *   interpret(item) -> { interpreter, per_asset: [ { asset, stance, kind, mechanism, horizon, supporting, contradicting, limitations, rule_ids } ] }
 * and may throw. The ingester treats a throw or a malformed result as "interpretation unavailable": the article stays
 * visible and nothing is stored. Core retrieval never depends on an interpreter.
 *
 * Honesty rules (enforced by tests):
 *   - stance is one of BULLISH | BEARISH | NEUTRAL | MIXED | UNCERTAIN. An item with no relevance has NO interpretation
 *     (UNAVAILABLE); that is not NEUTRAL. A relevant item that no rule covers is UNCERTAIN with rule "no_rule_matched".
 *   - NEUTRAL is produced only by an explicit rule for administrative notices; it means "no policy content identified by the
 *     rule", not "measured zero effect".
 *   - BULLISH / BEARISH mean a POTENTIAL direction through the stated mechanism, from headline-level keyword rules that have
 *     NOT been evaluated against price outcomes. There is no numeric score or probability. They are not trade signals.
 *   - Company/exchange announcements are interested-party claims; every such interpretation says so.
 *   - Whether something is "already priced in" is never asserted. Observed price reaction is shown separately by the API. */

const INTERPRETER = "news-rules-v1.1";   // v1.1: "tokenized" no longer implies crypto (tokenized equities are not a crypto-market signal)
const TRACKED = ["BTC", "ETH", "XRP"];
const STANCES = new Set(["BULLISH", "BEARISH", "NEUTRAL", "MIXED", "UNCERTAIN"]);
const KINDS = new Set(["price_direction", "operational_risk", "informational"]);

const RX = {
  admin: /\b(schedule|calendar|tentative|comment period|extend[s]? the comment|extension of|technical (change|correction)|reappointment|appoint(s|ment)|nominat\w+)\b/i,
  policyDecision: /\b(federal open market committee (statement|announces)|fomc statement|(raises?|lowers?|cuts?|increases?|decreases?|maintains?|holds?|keeps?|leaves?) .{0,40}\b(target range|interest rate|federal funds|discount rate|rates)\b|implementation note|primary credit rate)\b/i,
  speech: /\b(speech|testimony|remarks|statement by|interview|conversation)\b/i,
  adverse: /\b(charges?[sd]?|fraud|enforcement|penalt\w+|lawsuit|complaint|barred|sanction\w*|settles?[d]?|injunction|violat\w+)\b/i,
  // "custody"/"tokenization" alone is ambiguous (a fraud case can be about custody): they count as enabling only inside proposal-style wording
  enabling: /\b(exemption|exempt(ive)? relief|approv(e[sd]?|al)|permit(s|ted)?|authori[sz]e[sd]?|clarity|framework|innovation|safe harbor|no-action)\b|\b(propos\w+|would)\b.{0,80}\b(custod\w*|tokeni[sz]\w*)\b/i,
  delist: /\b(delist\w*|removal of|suspend\w* (spot|futures|trading)|terminate\w* trading)\b/i,
  venueOps: /\b(futures|perpetual|usdt-m|system (upgrade|maintenance)|maintenance|api|websocket|matching|trading (suspension|halt)|outage|incident)\b/i
};

function text(item) { return `${item.title || ""} ${item.summary || ""}`; }
const idx = (item, asset) => (item.assets || []).includes(asset);
/** Assets an item applies to: the tracked coins it names, else all three for crypto-wide / macro / venue-wide items. */
function appliesTo(item) {
  const named = TRACKED.filter(a => idx(item, a));
  if (named.length) return named;
  if ((item.assets || []).includes("crypto") || item.scope === "MACRO" || item.scope === "EXCHANGE_OPS") return TRACKED.slice();
  return [];
}
const INTERESTED = "Published by the exchange/issuer itself: an interested-party claim, not independent corroboration.";

/** Ordered rules; the first that matches decides. Each returns the common body. */
const RULES = [
  { id: "R1_admin_notice", when: (i, t) => i.scope === "MACRO" && RX.admin.test(t) && !RX.policyDecision.test(t),
    out: () => ({ stance: "NEUTRAL", kind: "informational", mechanism: null, horizon: null,
      supporting: ["Administrative or scheduling notice; no change to policy settings identified by the rule."], contradicting: [],
      limitations: ["NEUTRAL here means 'no policy content identified by a keyword rule', not a measured zero effect."] }) },
  { id: "R2_policy_decision", when: (i, t) => i.scope === "MACRO" && RX.policyDecision.test(t),
    out: () => ({ stance: "UNCERTAIN", kind: "price_direction", mechanism: "Policy-rate path changes USD liquidity and risk appetite, which can move crypto indirectly.", horizon: "minutes to days",
      supporting: ["Official monetary-policy communication."], contradicting: [],
      limitations: ["Direction depends on the surprise relative to market expectations; this system has no expectations or consensus data.", "Headline direction (cut/raise) is not used as a signal."] }) },
  { id: "R3_speech", when: (i, t) => i.scope === "MACRO" && RX.speech.test(t),
    out: () => ({ stance: "UNCERTAIN", kind: "price_direction", mechanism: "Forward guidance can shift rate expectations.", horizon: "hours to days",
      supporting: ["Official speech or testimony."], contradicting: [], limitations: ["Tone and content are not analysed; only the title is available to the rule."] }) },
  { id: "R6_exchange_delisting", when: (i, t) => i.source_category === "exchange" && TRACKED.some(a => idx(i, a)) && (i.event_type || "").includes("exchange_delisting"),
    out: () => ({ stance: "BEARISH", kind: "price_direction", mechanism: "Removal of a trading pair can reduce access and liquidity on that venue.", horizon: "hours to days",
      supporting: ["Exchange announces removal of a tracked asset's pair or product."], contradicting: ["Single venue; other venues unaffected.", INTERESTED],
      limitations: ["Potential direction only; effect size unknown and not evaluated."] }) },
  { id: "R7_exchange_listing", when: (i, t) => i.source_category === "exchange" && TRACKED.some(a => idx(i, a)) && /exchange_(listing|product)/.test(i.event_type || ""),
    out: () => ({ stance: "BULLISH", kind: "price_direction", mechanism: "New products or listings can widen access and demand on that venue.", horizon: "hours to days",
      supporting: ["Exchange announces a new listing or product involving a tracked asset."], contradicting: ["Often already communicated earlier; single venue.", INTERESTED],
      limitations: ["Potential direction only; effect size unknown and not evaluated."] }) },
  { id: "R8_venue_operations", when: (i, t) => i.scope === "EXCHANGE_OPS",
    out: () => ({ stance: "UNCERTAIN", kind: "operational_risk", mechanism: "Venue maintenance or incidents can pause or degrade matching, funding or API access, which raises execution and data-quality risk.", horizon: "during the stated window",
      supporting: ["Announcement concerns systems this platform trades or reads (Bitget perpetuals) or venue-wide operations."], contradicting: [INTERESTED],
      limitations: ["This is operational risk, not a price-direction claim.", "Automatic risk response to venue incidents is a separate, not yet built, module."] }) },
  { id: "R4R5_regulator_crypto", when: (i, t) => i.source_category === "regulator" && (i.assets || []).length > 0,
    out: (i, t) => {
      const bad = RX.adverse.test(t), good = RX.enabling.test(t);
      const stance = bad && good ? "MIXED" : bad ? "BEARISH" : good ? "BULLISH" : "UNCERTAIN";
      return { stance, kind: "price_direction", mechanism: bad && !good ? "Enforcement raises the perceived legal-risk premium for crypto market participants."
        : good && !bad ? "Clearer rules or exemptions can lower barriers to institutional access." : bad && good ? "Both restrictive and enabling language appear." : null,
        horizon: stance === "UNCERTAIN" ? null : "hours to weeks",
        supporting: [bad ? "Enforcement-type wording in the headline/summary." : null, good ? "Enabling or clarifying wording in the headline/summary." : null].filter(Boolean),
        contradicting: [good && !bad ? "A proposal or exemption may carry conditions or restrictions not visible in the headline." : null, bad && !good ? "An action against one party may be idiosyncratic rather than market-wide." : null].filter(Boolean),
        limitations: ["Keyword rule on headline text; the document itself was not read.", "Potential direction only; not evaluated against price outcomes."] };
    } }
];

function ruleInterpreter(item) {
  const assets = appliesTo(item);
  if (!assets.length) return { interpreter: INTERPRETER, per_asset: [] };                    // not relevant: UNAVAILABLE, not neutral
  const t = text(item);
  const rule = RULES.find(r => r.when(item, t));
  const body = rule ? rule.out(item, t) : { stance: "UNCERTAIN", kind: "informational", mechanism: null, horizon: null, supporting: [], contradicting: [],
    limitations: ["No interpretation rule covers this item."] };
  const rule_ids = [rule ? rule.id : "no_rule_matched"];
  const generic = (item.assets || []).includes("crypto") && !TRACKED.some(a => idx(item, a));
  return { interpreter: INTERPRETER, per_asset: assets.map(asset => ({ asset, ...body, rule_ids,
    limitations: body.limitations.concat(generic || item.scope === "MACRO" ? ["Applies to the crypto asset class generally; an asset-specific effect is not assessed."] : []) })) };
}

/** Strict validation of any interpreter's output (rule-based now, NLP/LLM adapters later). */
function validate(result) {
  if (!result || typeof result !== "object" || typeof result.interpreter !== "string" || !Array.isArray(result.per_asset)) throw new Error("malformed interpretation");
  for (const p of result.per_asset) {
    if (!TRACKED.includes(p.asset) || !STANCES.has(p.stance) || !KINDS.has(p.kind)) throw new Error("malformed interpretation entry");
    for (const k of ["supporting", "contradicting", "limitations", "rule_ids"]) if (!Array.isArray(p[k]) || p[k].some(x => typeof x !== "string")) throw new Error("malformed interpretation list " + k);
    for (const k of ["mechanism", "horizon"]) if (p[k] !== null && p[k] !== undefined && typeof p[k] !== "string") throw new Error("malformed interpretation field " + k);
    if ("score" in p || "confidence" in p || "probability" in p) throw new Error("numeric scores are not allowed: none has been evaluated");
  }
  return result;
}

/** Registered interpreters. Only the rule interpreter is enabled; an LLM adapter is deliberately NOT present. */
const INTERPRETERS = { "news-rules-v1.1": { enabled: true, run: ruleInterpreter, note: "keyword rules, headline level, unevaluated" },
  "llm-grounded": { enabled: false, run: null, note: "disabled: no runtime model access or budget has been verified; retrieval does not depend on it" } };

module.exports = { INTERPRETER, TRACKED, RULES, ruleInterpreter, validate, INTERPRETERS, appliesTo };
