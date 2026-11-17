# Resume here

**State (2026-11-17, end of research Slice 1).** Branch `claude/friendly-dirac-ouvgn4` was merged into `main` through PR #1 (merge commit `89826e4`); the public site is published from `main`. **Anything pushed to `main` publishes the site: ask before any push.** Local work after the merge is uncommitted/unpushed unless `git log origin/main..HEAD` says otherwise.

## What exists
* Platform: evidence-v1 snapshots, three rule analysts (`server/policies.js`), independent risk gate, paper engine, stress detector (SHADOW), live Open-positions panel, accounting contract (`accounting-contract.md`), legacy-simulator relabel. Schema v10. No edge demonstrated.
* Research harness (`research/`, local): public 180-day candles (`data/hist`, gitignored; refetch with `node research/fetch_native.js 180 && node scripts/stress_fetch_1m.js 180`), parity validation, replay simulator, baselines, evaluation. Report: `hist-evaluation-report.md` (headline: no analyst makes money after costs, none beats random entry; roughly break-even before costs). Decision D-033.
* Forward worker 8787 (when the session is alive): schema v10, stress SHADOW, valuation recorder. It dies with the session; start it only if no worker is running (D-029), never restart a healthy one while positions are open (D-022). Back up `data/market.db` first.

## Next exact steps
1. Pre-registration (`research-preregistration.md`) committed BEFORE any model fit; then Slice 2: dataset builder (same JS feature code, hashed manifest), Python baseline fits, model registry/trial log in files (no forward-DB writes, no v11), JSON coefficient export with JS/Python parity test.
2. Model Lab tab/API and a bounded self-training loop on the user's PC: never auto-promotes, refuses to start during HIGH/CRITICAL stress, REJECTED displayed; forward shadow is the only true holdout.
3. Ask before: pushing, merging, deploying, paid services (Firecrawl), new network hosts, ENFORCE stress mode.

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`; pytest/numpy/pandas/scikit-learn must be pip-installed after a container reset. Node 22.23.4.
* CI (`.github/workflows/tests.yml`) runs pytest and `node --test "tests_js/*.test.js"` on a clean checkout: tests must not read gitignored files (`data/`, `docs/data/`); use committed fixtures.
* User's Windows machine is not reachable from the cloud; the cloud ledger is not the Windows ledger.
