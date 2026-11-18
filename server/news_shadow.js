"use strict";
/* Records news-overlay-v1 assessments for candidate entries, AFTER the decision transaction. A failure here is logged and ignored: it can never alter, delay or block a decision. */
const { assess, VERSION } = require("./news_overlay"), { appliesTo } = require("./news_interpret");
const MIN = 60000;
class NewsShadow {
  constructor({ db, news, now = Date.now, log = () => {} }) { Object.assign(this, { db, news, now, log }); }
  /** price move in bps from the last complete 1m close before DISCOVERY to the last complete 1m close at or before the decision (candles that ended by decisionTs only) */
  moveFn(asset, decisionTs) {
    const id = `bitget:perp:${asset}USDT`;
    return (item) => {
      const refOpen = Math.floor(item.discovered_ts / MIN) * MIN - MIN, endOpen = Math.floor(decisionTs / MIN) * MIN - MIN;
      if (endOpen <= refOpen) return { status: "PENDING" };
      const ref = this.db.prepare("SELECT c FROM candles WHERE instrument_id=? AND interval='1m' AND open_ts=? AND final=1").get(id, refOpen);
      const end = this.db.prepare("SELECT c FROM candles WHERE instrument_id=? AND interval='1m' AND open_ts=? AND final=1").get(id, endOpen);
      if (!ref || !end) return { status: "NA" };
      return { status: "OK", bps: (Number(end.c) / Number(ref.c) - 1) * 1e4 };
    };
  }
  record({ analyst, instrument_id, decisionId, intent, code, decisionTs }) {
    if (intent !== "OPEN_LONG" && intent !== "OPEN_SHORT") return null;
    const asset = instrument_id.split(":").pop().replace("USDT", ""), direction = intent === "OPEN_LONG" ? 1 : -1;
    const items = this.news.itemsAsOf(decisionTs, { limit: 60, asset }).filter(i => appliesTo(i).includes(asset));
    const a = assess({ analyst, direction, asset, decisionTs, items, move: this.moveFn(asset, decisionTs) });
    this.db.prepare("INSERT OR IGNORE INTO news_shadow (decision_id, analyst, instrument_id, decision_ts, intent, risk_outcome, verdict, would_change, overlay_version, assessment, created_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(decisionId, analyst, instrument_id, decisionTs, intent, code || null, a.verdict, a.would_change_decision ? 1 : 0, VERSION, JSON.stringify(a), this.now());
    return a;
  }
}
module.exports = { NewsShadow };
