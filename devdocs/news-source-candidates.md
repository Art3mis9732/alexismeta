# News source expansion — candidates only (nothing contacted, nothing enabled)

Status as of 2026-11-17: **no new host has been contacted.** The cloud environment allows only the hosts already used (federalreserve.gov,
www.sec.gov, api.bitget.com, www.okx.com). Adding a host needs one `update_environment` proposal listing exact hostnames, which the
user must approve; on the user's own Windows machine there is no such environment allowlist, only the per-source host list in
`server/news.js` (`SOURCES[*].hosts`), which is code and is reviewed like any change. The URLs below come from an external analysis
(Astra) and from the project's earlier notes. **They are unverified by me**: availability, redirects, terms, rate limits and parseability
are unknown until a request is approved and made.

| Candidate | Exact host | Candidate endpoint (unverified) | Role | Open questions |
|---|---|---|---|---|
| ECB press | www.ecb.europa.eu | /rss/press.html (directory of feeds) | macro policy context | actual feed URL, redirects, items per feed, terms |
| BLS releases | www.bls.gov | /feed/ and /feed/cpi.rss | scheduled macro releases (CPI) | an RSS "release" is a scheduled data event, not crypto news; need release-time semantics |
| CFTC press | www.cftc.gov | /PressRoom/PressReleases (HTML); RSS reportedly disabled | regulator | external analysis says RSS was disabled in Oct 2026; HTML adapter would be fragile and needs its own parser and fixtures |
| Ethereum Foundation blog | blog.ethereum.org | /en/feed.xml | first-party project announcements | feed format and redirects unverified |
| Ripple | ripple.com | /insights/ (HTML, no verified RSS) | first-party XRP-related company material | company perspective, not independent evidence; no RSS verified; do not invent one |

Rules if approved: one adapter per source with a recorded real-capture fixture; per-source host allowlist; conservative polling (≥10 min,
back-off after 403/429 as in `news.js`); `verification` labelled `official primary` only for the issuer's own statement about itself, and
`INTERESTED_PARTY_CLAIM` for projects talking about their own token; no scraping service (no Firecrawl credits without explicit approval).
Cost: free (public feeds). Rate limits: unknown until measured; none of these is guaranteed by a service-level agreement.
