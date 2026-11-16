# Resume here

**Branch:** `claude/friendly-dirac-ouvgn4` (local commits; see `progress.md` for push status)
**Phase:** 3 — UI honesty (worker-aware status strip; fix A-01 LIVE label, A-02 "chance" label)
**Last verified checkpoint:** worker (Phase 2 perps) + ledger (2b) committed and pushed; `npm test` 55/55; live smoke pass.

## Next exact steps
1. `docs/index.html`: probe same-origin `/api/health`; if present show worker feed states; otherwise label
   "browser stream / static snapshot". LIVE only from data messages (not pong). Relabel the model card as an
   uncalibrated score. Verify with Playwright (static mode + worker mode) and keep existing workflows working.
2. Then Phase 4 feature specs, starting with spread/depth bands from `book_tops` and the realized-vol fixtures.
3. Live smoke in the cloud container needs `NODE_USE_ENV_PROXY=1`.

## Running processes
None.

## Pending approvals
* None. Pushing the feature branch is approved (B-01); merge/PR/deploy are NOT.

## Environment notes
* Cloud container: Node needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS. Python venv at `.venv` (git-ignored).
* Worker DB: `data/worker/` (git-ignored).
