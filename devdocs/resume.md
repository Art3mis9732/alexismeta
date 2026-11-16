# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4` (local commits; see `progress.md` for push status)
**Phase:** 2 — market data slice (Bitget BTCUSDT perp)
**Last verified checkpoint:** Phase 0/1 docs committed; baseline 23 Node + 22 pytest pass.

## Next exact steps
1. `server/` zero-dependency Node worker per `roadmap.md` module list; tests in `tests_js/worker.*.test.js`.
2. Fixture tests for duplicate, out-of-order, seq-gap, stale, restart and quarantine.
3. Live smoke `NODE_USE_ENV_PROXY=1 node server/main.js --smoke` (proxy flag needed in the cloud container only).
4. Then Phase 2b: append-only ledger.

## Running processes
None.

## Pending approvals
* B-01: push the feature branch (no workflow is triggered).

## Environment notes
* Cloud container: Node needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS. Python venv at `.venv` (git-ignored).
* Worker DB: `data/worker/` (git-ignored).
