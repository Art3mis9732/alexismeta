# Verification log (validation report)

Each entry records: revision · command/procedure · when (UTC) · expected · observed · limitations.
"Cloud container" = this ephemeral Linux session; it does not verify the Windows runtime.

## V-001 Initial repository state (Phase 0)
* Revision `8de2e2a` (branch `claude/friendly-dirac-ouvgn4` = `origin/main`). 2026-11-16 ~07:40.
* `git status`: clean, nothing staged, no untracked files. Remote `gh-pages` = `7db64c3` ("publish 2026-11-16T06:51Z").
* Observed: no user changes to preserve. Forward journal copied read-only from `gh-pages` to
  `devdocs/evidence/gh-pages-journal-2026-11-16.json` (109 trades since 2026-11-11 12:53 UTC; legacy profiles).

## V-002 Baseline tests (Phase 0)
* `node --test tests_js/patterns.test.js` → 23 pass, 0 fail (Node 22.23.4).
* `.venv/bin/python -m pytest -q` → 22 passed (Python 3.13.18, pandas 3.1.1, numpy 2.5.5, pytest 9.2.0).
  CI uses Python 3.11; versions differ, results agree.
* Limitations: no CI run was triggered (nothing was pushed).

## V-003 Bitget reachability (cloud container)
* Default environment: CONNECT 403 for `api.bitget.com` (proxy policy).
* After the user approved the `alexismeta` environment (hosts listed in `data-sources.md`):
  `GET /api/v2/public/time` → 200 `00000`; Node `fetch` with `NODE_USE_ENV_PROXY=1` OK; Node built-in `WebSocket`
  to `wss://ws.bitget.com/v2/ws/public` → `ticker`, `trade`, `candle1m`, `books`, `books15` subscriptions
  acknowledged, and snapshot and update messages received (2026-11-16 ~07:46 UTC).
