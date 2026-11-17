"use strict";
/* Download PUBLIC Bitget history for research: native 15m candles (what the live system uses) and funding-rate history. Free, rate-limited, no key.
 *   node research/fetch_native.js [days=180]      -> data/hist/15m_<SYM>.json   rows [open_ts, o, h, l, c, base_vol, quote_vol]
 *                                                  -> data/hist/funding_<SYM>.json (if the public endpoint answers)
 * Gaps are reported, never filled. data/hist is gitignored (large, re-creatable). */
const fs = require("node:fs"), path = require("node:path");
const { BitgetRest } = require("../server/adapters/bitget");
const OUT = path.join(__dirname, "..", "data", "hist"), SYMS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"], BAR = 900000, PAGE = 200;
(async () => {
  const days = Number(process.argv[2] || 180), R = new BitgetRest({ baseUrl: "https://api.bitget.com" }), end = Math.floor(Date.now() / BAR) * BAR, start = end - days * 86400000;
  fs.mkdirSync(OUT, { recursive: true });
  for (const sym of SYMS) {
    const rows = new Map(); let t = start, req = 0;
    while (t < end) {
      const e = Math.min(end, t + PAGE * BAR);
      const { body } = await R.get("/api/v2/mix/market/history-candles", { symbol: sym, productType: "USDT-FUTURES", granularity: "15m", limit: String(PAGE), startTime: String(t), endTime: String(e) });
      for (const r of body.data) { const ts = Number(r[0]); if (ts >= start && ts < end) rows.set(ts, [ts, r[1], r[2], r[3], r[4], r[5], r[6]]); }
      t = e; req++;
    }
    const out = [...rows.values()].sort((a, b) => a[0] - b[0]), expected = Math.round((end - start) / BAR);
    fs.writeFileSync(path.join(OUT, `15m_${sym}.json`), JSON.stringify(out));
    let fund = null;
    try {                                                                                        // funding history: public endpoint, paged; absence is reported, not assumed
      const all = []; for (let page = 1; page <= 30; page++) { const { body } = await R.get("/api/v2/mix/market/history-fund-rate", { symbol: sym, productType: "USDT-FUTURES", pageSize: "100", pageNo: String(page) }); if (!body.data || !body.data.length) break; all.push(...body.data); if (body.data.length < 100) break; }
      all.sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime)); fs.writeFileSync(path.join(OUT, `funding_${sym}.json`), JSON.stringify(all.map(x => [Number(x.fundingTime), x.fundingRate])));
      fund = { rows: all.length, from: all.length ? new Date(Number(all[0].fundingTime)).toISOString() : null, to: all.length ? new Date(Number(all[all.length - 1].fundingTime)).toISOString() : null };
    } catch (e) { fund = { error: e.message.slice(0, 120) }; }
    console.log(JSON.stringify({ sym, bars: out.length, expected, missing: expected - out.length, from: new Date(out[0][0]).toISOString(), to: new Date(out[out.length - 1][0]).toISOString(), funding: fund }));
  }
})().catch(e => { console.error("FAILED", e.message); process.exit(1); });
