from bgbot.oms import OMS, FakeExchange, client_oid, live_allowed


def make(tmp_path, **kw):
    ex = FakeExchange(price=100.0)
    for k, v in kw.items():
        setattr(ex, k, v)
    oms = OMS(ex, tmp_path / "journal.jsonl")
    oms.on_price("BTCUSDT", 100.0)
    oms.reconcile_on_start()
    return ex, oms


def test_no_entry_before_reconcile(tmp_path):
    ex = FakeExchange()
    oms = OMS(ex, tmp_path / "j.jsonl")
    oms.on_price("BTCUSDT", 100.0)
    assert oms.enter("BTCUSDT", 1, 1.0, 97.0, "x")["reason"] == "not reconciled"


def test_happy_path_places_stop(tmp_path):
    ex, oms = make(tmp_path)
    r = oms.enter("BTCUSDT", 1, 1.0, 97.0, client_oid("trend", "BTCUSDT", 1, 1))
    assert r["status"] == "open_protected"
    stops = ex.open_orders()
    assert len(stops) == 1 and stops[0].reduce_only and stops[0].qty == 1.0 and stops[0].side == -1


def test_duplicate_signal_does_not_double_fill(tmp_path):
    ex, oms = make(tmp_path)
    oid = client_oid("trend", "BTCUSDT", 1, 1)
    oms.enter("BTCUSDT", 1, 1.0, 97.0, oid)
    r2 = oms.enter("BTCUSDT", 1, 1.0, 97.0, oid)
    assert r2["status"] == "skipped"          # position already open
    assert ex.positions()["BTCUSDT"] == (1, 1.0)


def test_timeout_after_accept_reconciles_by_oid_no_duplicate(tmp_path):
    ex, oms = make(tmp_path, fail_next_entry_timeout_after_accept=True)
    r = oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-1")
    assert r["status"] == "open_protected"
    assert ex.positions()["BTCUSDT"] == (1, 1.0)      # exactly one fill


def test_timeout_before_accept_retries_same_oid(tmp_path):
    ex, oms = make(tmp_path, fail_next_entry_timeout_before_accept=True)
    r = oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-2")
    assert r["status"] == "open_protected"
    assert "bg-oid-2" in ex.orders and ex.positions()["BTCUSDT"] == (1, 1.0)


def test_stop_rejection_after_fill_closes_and_halts(tmp_path):
    ex, oms = make(tmp_path, reject_stops=2)
    r = oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-3")
    assert r["status"] == "closed_unprotected"
    assert "BTCUSDT" not in ex.positions()
    assert "BTCUSDT" in oms.halted_symbols
    assert any(level == "CRITICAL" for level, _ in oms.alerts)


def test_stop_rejected_once_then_ok(tmp_path):
    ex, oms = make(tmp_path, reject_stops=1)
    assert oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-4")["status"] == "open_protected"


def test_partial_fill_protects_only_filled_qty(tmp_path):
    ex, oms = make(tmp_path, partial_fill_frac=0.4)
    r = oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-5")
    assert r["status"] == "open_protected" and abs(r["filled"] - 0.4) < 1e-12
    assert abs(ex.open_orders()[0].qty - 0.4) < 1e-12


def test_restart_recovers_unprotected_unknown_position(tmp_path):
    ex = FakeExchange()
    ex.pos["ETHUSDT"] = [1, 2.0]                      # position opened outside the bot, no stop
    oms = OMS(ex, tmp_path / "j.jsonl")
    oms.on_price("ETHUSDT", 100.0)
    oms.reconcile_on_start()
    assert oms.ready
    assert any(o.symbol == "ETHUSDT" and o.reduce_only for o in ex.open_orders())
    assert "ETHUSDT" in oms.halted_symbols
    assert oms.enter("ETHUSDT", 1, 1.0, 97.0, "z")["status"] == "skipped"


def test_restart_reuses_journaled_stop_price(tmp_path):
    ex, oms = make(tmp_path)
    oms.enter("BTCUSDT", 1, 1.0, 97.0, "bg-oid-6")
    ex.orders = {k: v for k, v in ex.orders.items() if v.kind != "stop"}   # stop vanished (e.g. canceled)
    oms2 = OMS(ex, tmp_path / "journal.jsonl")
    oms2.reconcile_on_start()
    st = ex.open_orders()
    assert len(st) == 1 and st[0].trigger == 97.0
    assert "BTCUSDT" not in oms2.halted_symbols      # known position: protected, not halted


def test_stale_price_blocks_entries(tmp_path):
    ex, oms = make(tmp_path)
    oms.max_staleness_s = -1
    assert oms.enter("BTCUSDT", 1, 1.0, 97.0, "s")["reason"] == "stale price"


def test_live_disabled_by_default(monkeypatch):
    monkeypatch.delenv("BGBOT_LIVE", raising=False)
    assert not live_allowed(True)
    assert not live_allowed(False)
