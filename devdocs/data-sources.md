# Data-source capability registry

"Probe" = a request actually made from the runtime named. A docs page alone never counts as access.
Cloud container = this Claude Code session behind an egress proxy. It says nothing about the user's Windows PC.

## Bitget — Classic v2 public (primary venue)

| Dataset | Endpoint / channel | Instruments | Auth | Limits (source) | Probe 2026-11-16 (cloud container) | Notes / gaps | Fallback |
|---|---|---|---|---|---|---|---|
| Server time | `GET /api/v2/public/time` | – | none | – | 200, code 00000 | used for clock-offset | none |
| Contracts | `GET /api/v2/mix/market/contracts?productType=USDT-FUTURES` | BTC/ETH/XRP USDT perps | none | 20 req/s/IP per the repo's 2026-11-11 notes (to re-verify) | used by repo 2026-11-11 | min size, step, multiplier, fundInterval | config values |
| Tickers | `GET /api/v2/mix/market/tickers` | same | none | " | used by repo | last, mark, index, bid/ask, funding, OI (`holdingAmount`, base coin) | WS ticker |
| Candles | `GET /api/v2/mix/market/candles` (≤1000), `history-candles` (≤200/page) | same | none | " | used by repo + browser | trade-price OHLCV; partial candle included as last row | – |
| WS ticker | `wss://ws.bitget.com/v2/ws/public` `ticker` | same | none | ping every 30 s, text `ping`→`pong` (repo uses 25 s) | **OK** (snapshot received) | | REST tickers |
| WS trades | `trade` | same | none | | **OK**: `{ts, price, size, side, tradeId}`, snapshot then updates | `side` aggressor meaning **unverified** (D-008) | REST fills endpoint (not yet probed) |
| WS candles | `candle1m/5m/15m/4H` | same | none | | **OK**: snapshot of ~500 rows, then updates of the forming candle | array `[ts,o,h,l,c,baseVol,quoteVol,quoteVol]` | REST candles |
| WS books (incremental) | `books` | same | none | push ~150 ms futures (official best practices) | **OK**: snapshot (`pseq`=0) then updates with `seq`/`pseq` chaining, size `"0"` = delete | continuity rule observed, not documented (D-007) | resubscribe |
| WS books15 | `books15` | same | none | snapshot every push | OK | 15 levels only | – |
| Funding history | `GET /api/v2/mix/market/history-fund-rate` | same | none | | used by lab | settlement times | – |
| Position tiers | `GET /api/v2/mix/market/query-position-lever` | same | none | | used by repo | tier-1 MMR 0.004 (2026-11-11) | config |
| Long/short accounts, taker buy/sell | `account-long-short`, `taker-buy-sell` | same | none | | used by repo | aggregates, 15m period; semantics per Bitget | – |

Official docs: classic docs moved to `https://www.bitget.com/legacy-docs/classic/` (best-practices page read
2026-11-16: "`books` first push is full data `snapshot`, subsequent pushes are incremental `update`"; books5/15 are
snapshot-only; futures push ~150 ms; "When there are no changes to the order book, the system will not send new
snapshots"). `https://www.bitget.com/api-doc/...` now redirects to the UTA docs.
Terms: public market data; **redistribution rights not established**. The public site already shows Bitget data;
check Bitget's terms before any commercial or redistribution use.

## Secondary / context (not yet implemented)

| Provider | Host allowed in the environment | Probe | Status |
|---|---|---|---|
| OKX v5 public | www.okx.com, ws.okx.com | not yet | Phase 6 |
| Federal Reserve RSS `feeds/press_all.xml` | www.federalreserve.gov | 2026-11-16: 200 RSS, 20 items; **intermittently an HTML soft-404 with HTTP 200** (rejected) | IMPLEMENTED (10-min poll, ETag) |
| SEC RSS `news/pressreleases.rss` | www.sec.gov. SEC fair-access guidance asks for a declared User-Agent; a generic client name was used and accepted (200). If the SEC starts refusing it, the user decides whether to supply a contact | 2026-11-16: 200 RSS, 25 items | IMPLEMENTED (10-min poll) |
| Binance, Bybit, Coinbase, CoinGecko, DefiLlama, CFTC, FRED | not allowed in the environment | – | DEFERRED until one venue path is verified |

## Retention plan (worker, initial values; to be measured)

| Table | Keep | Why |
|---|---|---|
| trades | 3 days (BTC/ETH/XRP perps) | trade-level features need recent windows; ~10^5–10^6 rows/day/symbol |
| book_tops (sampled every 1 s, top-N=20) | 2 days | depth features; full depth is never stored |
| tickers (sampled every 1 s) | 7 days | mark/index/funding/OI history |
| candles 1m | 90 days; 15m/1H/4H: indefinite (small) | baselines |
| quarantine | 7 days | debugging |
| ledger | forever (append-only) | audit |
