"use strict";
/* Download public Bitget USDT-perp 1m candles (history endpoint) for stress calibration -> data/hist/1m_<SYM>.json  (gitignored).
 *   node scripts/stress_fetch_1m.js [days=90]
 * Public, unauthenticated, rate-limited by the shared REST client. Rows: [open_ts, o, h, l, c, base_vol, quote_vol]. Gaps are reported, never filled. */
const fs = require("node:fs"), path = require("node:path");
const { BitgetRest } = require("../server/adapters/bitget");
const OUT = path.join(__dirname, "..", "data", "hist"), SYMS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"], MIN = 60000, PAGE = 200;
(async () => {
  const days = Number(process.argv[2] || 90), R = new BitgetRest({ baseUrl: "https://api.bitget.com" }), end = Math.floor(Date.now() / MIN) * MIN, start = end - days * 86400000;
  fs.mkdirSync(OUT, { recursive: true });
  for (const sym of SYMS) {
    const rows = new Map(); let t = start, req = 0;
    while (t < end) {
      const e = Math.min(end, t + PAGE * MIN);
      const { body } = await R.get("/api/v2/mix/market/history-candles", { symbol: sym, productType: "USDT-FUTURES", granularity: "1m", limit: String(PAGE), startTime: String(t), endTime: String(e) });
      for (const r of body.data) { const ts = Number(r[0]); if (ts >= start && ts < end) rows.set(ts, [ts, r[1], r[2], r[3], r[4], r[5], r[6]]); }
      t = e; req++;
    }
    const out = [...rows.values()].sort((a, b) => a[0] - b[0]), expected = Math.round((end - start) / MIN);
    fs.writeFileSync(path.join(OUT, `1m_${sym}.json`), JSON.stringify(out));
    console.log(JSON.stringify({ sym, requests: req, rows: out.length, expected, missing: expected - out.length, from: new Date(out[0][0]).toISOString(), to: new Date(out[out.length - 1][0]).toISOString() }));
  }
})().catch(e => { console.error("FAILED", e.message); process.exit(1); });
