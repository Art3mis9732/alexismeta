"""Order-management safety layer, exchange-agnostic. The Bitget demo adapter (next
milestone) implements the `Exchange` protocol; tests use FakeExchange.

Guarantees enforced here:
  1. No entry until startup reconciliation has completed (positions + open orders).
  2. Deterministic client order IDs -> a retried or restarted entry can never double-fill.
  3. Entry timeout -> look the order up by client OID BEFORE any retry; retry reuses the same OID.
  4. Every filled quantity (incl. partial fills) gets a reduce-only stop immediately.
  5. Stop rejected/failed -> one retry, then immediate reduce-only market close + CRITICAL alert
     + entries halted for that symbol.
  6. Unknown/unexpected exchange positions -> protect (or close) and halt entries until a human acks.
  7. Stale prices -> no entries.
Live trading is OFF unless config live=true AND env BGBOT_LIVE == "I_ACCEPT_REAL_MONEY_RISK".
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class ExchangeTimeout(Exception):
    pass


class OrderRejected(Exception):
    pass


@dataclass
class Order:
    client_oid: str
    symbol: str
    side: int
    qty: float
    kind: str                 # "market" | "stop"
    reduce_only: bool = False
    trigger: float | None = None
    filled: float = 0.0
    avg_px: float = 0.0
    status: str = "new"       # new | filled | partial | canceled | rejected


class Exchange(Protocol):
    def place_order(self, o: Order) -> Order: ...
    def get_order(self, symbol: str, client_oid: str) -> Order | None: ...
    def cancel_order(self, symbol: str, client_oid: str) -> None: ...
    def positions(self) -> dict[str, tuple[int, float]]: ...      # symbol -> (side, qty)
    def open_orders(self) -> list[Order]: ...


def client_oid(strategy: str, symbol: str, signal_ts_ms: int, side: int, purpose: str = "entry") -> str:
    return f"bg-{strategy[:4]}-{symbol}-{signal_ts_ms}-{'L' if side > 0 else 'S'}-{purpose}"[:40]


@dataclass
class OMS:
    ex: Exchange
    journal_path: Path
    max_staleness_s: float = 15.0
    unexpected_position_action: str = "protect_and_halt"   # or "close"
    emergency_stop_frac: float = 0.03                     # used only if a stop price is unknown
    ready: bool = False
    halted_symbols: set = field(default_factory=set)
    global_halt: bool = False
    alerts: list = field(default_factory=list)
    last_price: dict = field(default_factory=dict)        # symbol -> (price, monotonic time)

    # ---- journal ---------------------------------------------------------
    def _log(self, **ev) -> None:
        ev["t"] = time.time()
        with open(self.journal_path, "a") as f:
            f.write(json.dumps(ev) + "\n")

    def _journal(self) -> list[dict]:
        if not Path(self.journal_path).exists():
            return []
        return [json.loads(x) for x in Path(self.journal_path).read_text().splitlines() if x.strip()]

    def alert(self, level: str, msg: str) -> None:
        self.alerts.append((level, msg))
        self._log(ev="alert", level=level, msg=msg)

    def on_price(self, symbol: str, px: float) -> None:
        self.last_price[symbol] = (px, time.monotonic())

    # ---- startup ---------------------------------------------------------
    def reconcile_on_start(self) -> None:
        pos = self.ex.positions()
        stops = [o for o in self.ex.open_orders() if o.kind == "stop" and o.reduce_only]
        known_stop = {}
        for ev in self._journal():
            if ev.get("ev") == "stop_placed":
                known_stop[ev["symbol"]] = ev["trigger"]
        for sym, (side, qty) in pos.items():
            if qty <= 0:
                continue
            covered = sum(o.qty for o in stops if o.symbol == sym and o.side == -side)
            if covered + 1e-12 >= qty:
                continue
            journaled = sym in known_stop
            if not journaled and self.unexpected_position_action == "close":
                self._market_close(sym, side, qty, "unexpected position at startup")
                continue
            px = self.last_price.get(sym, (None, 0))[0]
            trigger = known_stop.get(sym) or (px * (1 - side * self.emergency_stop_frac) if px else None)
            if trigger is None:
                self._market_close(sym, side, qty, "unprotected position and no price for a stop")
                continue
            if not self._place_stop(sym, side, qty - covered, trigger, tag=f"recover-{int(time.time())}"):
                self._market_close(sym, side, qty, "could not protect position at startup")
            if not journaled:
                self.halted_symbols.add(sym)
                self.alert("CRITICAL", f"{sym}: position not in journal; protected and halted until human ack")
        self.ready = True
        self._log(ev="reconciled", positions={k: list(v) for k, v in pos.items()})

    # ---- entries ---------------------------------------------------------
    def can_enter(self, symbol: str) -> tuple[bool, str]:
        if not self.ready:
            return False, "not reconciled"
        if self.global_halt or symbol in self.halted_symbols:
            return False, "halted"
        px = self.last_price.get(symbol)
        if px is None or time.monotonic() - px[1] > self.max_staleness_s:
            return False, "stale price"
        if self.ex.positions().get(symbol, (0, 0.0))[1] > 0:
            return False, "position already open"
        return True, "ok"

    def enter(self, symbol: str, side: int, qty: float, stop_trigger: float, oid: str) -> dict:
        ok, why = self.can_enter(symbol)
        if not ok:
            return {"status": "skipped", "reason": why}
        # idempotency: if this client OID was ever sent, never send a fresh order
        prior = self.ex.get_order(symbol, oid)
        if prior is not None:
            entry = prior
        else:
            self._log(ev="entry_sent", symbol=symbol, oid=oid, side=side, qty=qty)
            entry = None
            for attempt in range(2):
                try:
                    entry = self.ex.place_order(Order(oid, symbol, side, qty, "market"))
                    break
                except ExchangeTimeout:
                    entry = self._lookup(symbol, oid)
                    if entry is not None:
                        break
                    # not visible after lookup: retry ONCE with the SAME oid (exchange dedupes)
                except OrderRejected as e:
                    self._log(ev="entry_rejected", symbol=symbol, oid=oid, err=str(e))
                    return {"status": "rejected", "reason": str(e)}
            if entry is None:
                self.halted_symbols.add(symbol)
                self.alert("CRITICAL", f"{symbol}: entry {oid} status UNKNOWN after retries; entries halted")
                return {"status": "unknown"}
        if entry.status == "partial":
            try:
                self.ex.cancel_order(symbol, oid)
            except Exception as e:                       # remainder may already be gone
                self._log(ev="cancel_remainder_failed", oid=oid, err=str(e))
        if entry.filled <= 0:
            return {"status": "not_filled"}
        self._log(ev="entry_filled", symbol=symbol, oid=oid, filled=entry.filled, px=entry.avg_px)
        if self._place_stop(symbol, side, entry.filled, stop_trigger, tag=oid):
            return {"status": "open_protected", "filled": entry.filled}
        self._market_close(symbol, side, entry.filled, "protective stop failed after fill")
        self.halted_symbols.add(symbol)
        return {"status": "closed_unprotected", "filled": entry.filled}

    # ---- helpers ---------------------------------------------------------
    def _lookup(self, symbol: str, oid: str, tries: int = 3, wait_s: float = 0.0):
        for _ in range(tries):
            try:
                o = self.ex.get_order(symbol, oid)
                if o is not None:
                    return o
            except ExchangeTimeout:
                pass
            time.sleep(wait_s)
        return None

    def _place_stop(self, symbol: str, side: int, qty: float, trigger: float, tag: str) -> bool:
        soid = (tag + "-SL")[-40:]
        for attempt in range(2):
            try:
                o = self.ex.place_order(Order(soid if attempt == 0 else soid[:-1] + "2", symbol, -side, qty,
                                              "stop", reduce_only=True, trigger=trigger))
                if o.status != "rejected":
                    self._log(ev="stop_placed", symbol=symbol, qty=qty, trigger=trigger, oid=o.client_oid)
                    return True
            except (OrderRejected, ExchangeTimeout) as e:
                self._log(ev="stop_failed", symbol=symbol, attempt=attempt, err=str(e))
                if isinstance(e, ExchangeTimeout) and self._lookup(symbol, soid) is not None:
                    self._log(ev="stop_placed", symbol=symbol, qty=qty, trigger=trigger, oid=soid)
                    return True
        return False

    def _market_close(self, symbol: str, side: int, qty: float, why: str) -> None:
        oid = f"bg-close-{symbol}-{int(time.time() * 1000)}"[:40]
        try:
            self.ex.place_order(Order(oid, symbol, -side, qty, "market", reduce_only=True))
            self.alert("CRITICAL", f"{symbol}: market-closed {qty} ({why})")
        except Exception as e:
            self.global_halt = True
            self.alert("CRITICAL", f"{symbol}: EMERGENCY CLOSE FAILED ({why}): {e}. Close manually NOW.")


def live_allowed(cfg_live: bool) -> bool:
    return bool(cfg_live) and os.environ.get("BGBOT_LIVE") == "I_ACCEPT_REAL_MONEY_RISK"


class FakeExchange:
    """In-memory exchange with failure injection for tests and the local paper broker."""

    def __init__(self, price: float = 100.0):
        self.price = price
        self.orders: dict[str, Order] = {}
        self.pos: dict[str, list] = {}               # symbol -> [side, qty]
        self.fail_next_entry_timeout_after_accept = False
        self.fail_next_entry_timeout_before_accept = False
        self.reject_stops = 0
        self.partial_fill_frac = 1.0
        self.placed_count = 0

    def place_order(self, o: Order) -> Order:
        if o.kind == "market" and not o.reduce_only and self.fail_next_entry_timeout_before_accept:
            self.fail_next_entry_timeout_before_accept = False
            raise ExchangeTimeout("timeout (never reached exchange)")
        if o.client_oid in self.orders:                # exchange-side idempotency
            raise OrderRejected("duplicate clientOid")
        if o.kind == "stop" and self.reject_stops > 0:
            self.reject_stops -= 1
            raise OrderRejected("stop rejected")
        self.placed_count += 1
        if o.kind == "market":
            frac = 1.0 if o.reduce_only else self.partial_fill_frac
            o.filled, o.avg_px = o.qty * frac, self.price
            o.status = "filled" if frac == 1.0 else "partial"
            side, qty = self.pos.get(o.symbol, [0, 0.0])
            signed = side * qty + o.side * o.filled
            self.pos[o.symbol] = [1 if signed > 0 else -1 if signed < 0 else 0, abs(signed)]
        self.orders[o.client_oid] = o
        if o.kind == "market" and not o.reduce_only and self.fail_next_entry_timeout_after_accept:
            self.fail_next_entry_timeout_after_accept = False
            raise ExchangeTimeout("timeout (order WAS accepted)")
        return o

    def get_order(self, symbol, client_oid):
        return self.orders.get(client_oid)

    def cancel_order(self, symbol, client_oid):
        o = self.orders.get(client_oid)
        if o and o.status == "partial":
            o.status = "canceled"

    def positions(self):
        return {k: (v[0], v[1]) for k, v in self.pos.items() if v[1] > 0}

    def open_orders(self):
        return [o for o in self.orders.values() if o.kind == "stop" and o.status == "new"]
