# News-to-trading intelligence: audit (Milestone A) and what is built (Milestone D, shadow)

## Milestone A: what the repository did on 2026-11-17 before this work
| Question | Answer (evidence) |
|---|---|
| News merely displayed? | Yes, plus filters and source health (News tab, `/api/news`). |
| Classified by deterministic rules? | Yes: `news.js` scope/asset/source-category rules, parser `news-v*`. |
| Interpreted by an LLM? | No. `news_interpret.js` runs keyword rules (`news-rules-v1.1`); the LLM adapter is registered but disabled (no verified model access or budget). |
| Compared with observed market reaction? | Yes, for display: `news_reaction.js` (move since DISCOVERY at 15m/1h/4h, N/A for backlog or gaps). |
| Used by any analyst? | **No.** `policies.js`, `evidence.js` and `engine.js` had no news input. |
| Used by the risk gate? | **No.** Only the market-stress gate (price, volume, liquidity) exists; its news context is display-only. |
| In historical or forward evaluations? | **No.** And it cannot be historically: the news store starts 2026-11-16 (7 official sources, mostly macro and exchange notices), so no point-in-time news history exists to replay. |

## What is now operational (SHADOW only)
`server/news_overlay.js` (pure) + `server/news_shadow.js` (recorder) + schema v11 `news_shadow` (append-only) + `/api/news/shadow` + a card on the News tab.
* For every analyst's **entry candidate** (OPEN_LONG / OPEN_SHORT) the engine records, **after** the decision transaction, what the news overlay would have said. It cannot change, delay or block a decision (a throwing recorder is tested to leave the ledger and positions identical).
* Inputs are point in time: articles discovered at or before the decision, never backlog items, never later revisions; price move measured from the last complete 1m close before DISCOVERY to the last complete 1m close at the decision time (later candles are not read; mutation-tested).
* A stance is never a signal alone. Verdicts: WOULD_BLOCK (venue/operations notice in the analyst's window), WOULD_VETO (bearish news against a long, or bullish against a short, **and** price moved at least 15 bps the same way since discovery; the Risk Taker only gets CAUTION), CAUTION (contradiction without a verified reaction for the Defensive analyst; macro uncertainty within an hour for the Defensive analyst), SUPPORTS (agreement confirmed by price; a note only, never extra size or a new trade), NEUTRAL, NO_RELEVANT_NEWS. Missing price data means unverified, never a veto. Windows: Risk Taker 1 h, Balanced 2 h, Defensive 4 h.
* Article text is never interpreted by the overlay (only stored stance and kind fields), so instruction-like article text has no effect (tested).
* The overlay is subtractive only: this version cannot generate a trade from news. Positive news never becomes BUY.
* Is influence shadow-only or approved? **Shadow only.** No active forward strategy changed (D-034).

## Not done, and why
* **Historical evaluation (Milestone G):** impossible today for lack of point-in-time news history; forward shadow rows are the data that will make it possible. The pre-registration for a news evaluation should wait until there are enough shadow candidates (a few hundred) and enough would-veto cases to compare, with an ablation (rules with and without the veto), costs, and a day-block interval.
* **LLM interpretation:** not enabled (no verified model access, no approved budget). Deterministic rules remain the interpreter; the LLM slot is unchanged.
* **More sources** (CFTC, ETF issuers, security incident feeds, crypto media): need host approval and a source-credibility policy; nothing contacted.
* **Risk-gate use:** the overlay does not feed the risk gate. Promoting WOULD_BLOCK/WOULD_VETO to a real entry restriction needs shadow evidence and your explicit approval.
* **Genuine ML on news:** none. The only trained models are the research fits in `research-model-results.md` (rejected); no news feature was in them.
Rollback: stop passing `newsShadow` to the engine (main.js) or ignore the table; v11 is additive and append-only.
