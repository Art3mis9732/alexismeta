# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4`. Pushing this branch only is approved (no PR, no merge, no deploy).
**Phase:** 4/5 thin vertical: evidence snapshot → 3 policies → independent risk gate → ledger → paper fills → outcome.
**Last verified checkpoint:** `0428a79`. `npm test` 59/59; Playwright `tests_e2e/status.e2e.js` 18/18 and the fallback check
pass; live smoke pass (V-005..V-011).

## Next exact steps
1. `server/evidence.js`: snapshot built only at a 15m bar close from `final=1` candles, contiguous across the lookback,
   plus ticker/book at decision time, feed health, book validity and `coverage()`; canonical JSON, hashed, stored.
2. `server/policies.js`: Risk Taker / Balanced / Defensive v1 as pure functions of the snapshot. Disagreement scenarios
   S1–S8 are in `roadmap.md` and were written BEFORE the policies.
3. `server/risk.js`: independent gate + sizing ported from `bgbot/sizing.py` with cross-language fixtures.
4. Ledger setup entries with deterministic ids; paper fills from book top; outcome or UNEVALUABLE.
5. Then Phase 3 remainder (TZ selector, accessibility), spot instruments, Phase 6 news.

## Running processes (cloud container only)
* Long-run worker on port 8790 (scratchpad `long.db`), used for the steady-run finality audit. Stop it with
  `pkill -INT -f "main[.]js --port 8790"`.
* Static server on 8788 (`python3 -m http.server`) for e2e. Stop it with `pkill -f "http[.]server 8788"`.

## Environment notes
* Cloud container: Node needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`.
* Python venv at `.venv` (git-ignored). Worker DB at `data/worker/` (git-ignored). `docs/data/*.json` copies are
  git-ignored.
* Unverified: Node 22.13 minimum (only 22.23 tested); Windows startup (B-03).
