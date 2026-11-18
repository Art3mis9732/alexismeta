# Resume here

**State (2026-11-17, end of research Slice 1).** Branch `claude/friendly-dirac-ouvgn4` was merged into `main` through PR #1 (merge commit `89826e4`); the public site is published from `main`. **Anything pushed to `main` publishes the site: ask before any push.** Local work after the merge is uncommitted/unpushed unless `git log origin/main..HEAD` says otherwise.

## What exists
* Platform: evidence-v1 snapshots, three rule analysts (`server/policies.js`), independent risk gate, paper engine, stress detector (SHADOW), live Open-positions panel, accounting contract (`accounting-contract.md`), legacy-simulator relabel. Schema v10. No edge demonstrated.
* Research (local, committed after the merge, NOT pushed): `research/` harness, `modellab/` Python pipeline, read-only Model Lab view in the monitor registry card, bounded loop `research/lab_loop.js`.
  * `hist-evaluation-report.md`: over 180 days no analyst makes money after costs and none is distinguishable from random entries (about -0.35 R per trade, break-even before costs). D-033.
  * `research-preregistration.md` (+ Amendments 1-2) was committed before any fit. `research-model-results.md`: first real fit = **REJECTED_ON_VALIDATION** (32 of 40 trials used; FINAL segment never read; boosting's log-loss gain is the cost effect, not an entry signal). Registry: `research/registry/`.
  * Data: `data/hist` (2 years of public candles, gitignored; refetch with `node research/fetch_native.js 730 && node scripts/stress_fetch_1m.js 730`, about 1 hour), dataset `data/research/dataset-v1` (rebuild reproduces sha256 `205a589a...`, peak memory about 2 GB, about 8 minutes).
* Forward worker 8787 (when the session is alive) runs build `89826e4` (older than the working tree, so it does not show the Model Lab card until restarted; whether it holds open positions was not checked this session: check before any restart, D-022). It dies with the session; start it only if none is running (D-029). Back up `data/market.db` first.

## Next exact steps
1. Public site: PR #3 merged (94251ea); the publishing job now writes `data/news.json` (7/7 sources answered from GitHub's runners on the first run). Confirm the public News tab in a browser when convenient (this container cannot fetch the public host).
2. Research: v3 (cost-aware entry filter for the analysts) was REJECTED by its registered criteria (`research-results-v3-cost-filter.md`; loss per trade falls monotonically with the filter but trade counts fall below the 200 minimum; a v4 with a wider K grid and a fresh final segment, or a forward shadow of the filter, are the next options). v1 and v2 (A, B) are all REJECTED_ON_VALIDATION with the final segments unread; next hypotheses are in `research-model-results-v2.md` (different information, cost-aware filter for the analysts, regression target, maker entries). Each needs its own pre-registration. Do not retune closed versions.
3. News to trading is SHADOW only (`news-to-trading.md`); it needs weeks of shadow rows before any evaluation. Run the worker on your PC (`windows-npm-verification.md`).
4. Ask before: pushing, merging, deploying, paid services, new network hosts, ENFORCE stress mode, any model promotion.

## Environment notes
* Cloud: `NODE_USE_ENV_PROXY=1` for outbound HTTPS/WSS; Playwright needs `NODE_PATH=$(npm root -g)`; `pip install -r requirements.txt` after a container reset (pandas, numpy, pytest, scikit-learn). Node 22.23.4.
* CI (`.github/workflows/tests.yml`) runs pytest and `node --test "tests_js/*.test.js"` on a clean checkout: tests must not read gitignored files (`data/`, `docs/data/`); use committed fixtures.
* User's Windows machine is not reachable from the cloud; the cloud ledger is not the Windows ledger.
