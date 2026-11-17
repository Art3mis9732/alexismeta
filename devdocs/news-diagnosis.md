# News display diagnosis (milestone B) — 2026-11-16 12:20–12:45 UTC

Question from the user: why is the news display empty or incomplete? Method: trace
SOURCE → FETCH → VALIDATE → PARSE → NORMALIZE → DEDUPLICATE → STORE → API → FILTER → RENDER on this container's worker,
then separate what was and was not observed.

| Stage | Observation (cloud container, forward worker) | Verdict |
|---|---|---|
| SOURCE / FETCH | Fed `press_all` and SEC `pressreleases.rss` returned 200 RSS; fetch log shows `ok` for both | OK |
| VALIDATE / PARSE | 20 + 25 items parsed; 0 quarantined; HTML-200 guard intact (fixture) | OK |
| STORE | 45 rows, all discovered in one first poll | OK |
| API | `/api/news` returned the 8 newest rows | OK |
| FILTER | **DEFECT 1:** `asset=BTC` returned 0 although 2 rows are tagged `crypto`: the filter ran after cutting to the newest `limit×3` rows; the tagged rows sat at positions 31 and 44 | bug, fixed (filter in SQL before the limit; test with 30 newer untagged + 1 older tagged) |
| RENDER | **DEFECT 2:** the news card lived inside the Buy/Sell view, but the worker-served page now opens on the Paper monitor, so the card was hidden; on the public static page it was hidden unconditionally | bug, fixed (dedicated **News** tab, always present, explicit empty states by cause) |
| Relevance | **LIMITATION 3:** only 2 of 45 Fed/SEC items mention crypto. Most official output is unrelated, so a relevance-only view is legitimately sparse. Previously the UI showed 8 unrelated items with no explanation | fixed: relevant-by-default with counts of what is hidden and a one-click "include unrelated" |
| Coverage | **MISSING SCOPE 4:** only two sources; no exchange incidents, no macro speeches | added Fed monetary + speeches, Bitget and OKX announcements (7 sources, all 200 from this container) |

What this container could not show: the user's Windows view. The user's checkout may be older than this branch, may have its own
database, and its network may be treated differently by sec.gov. Public GitHub Pages cannot show news at all: browsers cannot
read these feeds cross-origin and there is no hosted worker.

Found while testing, not in the user's report:
* The SEC returned **HTTP 403 "Request Rate Threshold Exceeded"** to a burst of manual probes. That is rate limiting, not a block of
  the client name. The ingester now backs off at least 30 minutes after a 403/429 and never hammers a source.
* Bitget's announcements endpoint rejects `limit=20` (code 40017); the cap is 10.
* A real rule bug: "tokenized" tagged an SEC item about **tokenized equities** as crypto and produced a BULLISH interpretation for
  BTC/ETH/XRP. Fixed (news-rules-v1.1) with a versioned supersession that keeps the old rows.
