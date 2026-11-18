# What Node.js/npm now enables: verification matrix and Windows steps

Evidence labels: **CLOUD-VERIFIED** = run in this session's Linux container (Node 22.23.4). **WINDOWS-VERIFIED** = run on your laptop and reported back. Nothing below is WINDOWS-VERIFIED yet: this container cannot reach your PC, and I have not seen your output.

## Matrix
| Original blocker | New prerequisite | Exact command / action | Result (evidence) | Remaining limitation |
|---|---|---|---|---|
| B-03 Windows startup untested | Node + npm on your laptop | the PowerShell block below | **PENDING your output** | WINDOWS-ONLY |
| Is `C:\Users\ASUS\Projects\crypto-monitor-local` this repository? | a checkout exists | `git remote -v` (expect `Art3mis9732/alexismeta`), `Get-Content package.json -TotalCount 12` (expect name `alexismeta`, engines node `>=22.23.0`) | **UNVERIFIED**: the path came from an earlier external analysis | WINDOWS-ONLY |
| Node version compatibility | Node 22.23 or later (`engines` in `package.json`; `node:sqlite` needs 22.5+) | `node --version` | cloud: v22.23.4 works; Windows: pending | WINDOWS-ONLY |
| JS tests | runtime | `npm.cmd test` | CLOUD-VERIFIED 255/255 (clean-checkout run in CI on Node 22.23: success on PR #3) | Windows pending |
| Python tests | Python 3.11+ with `pip install -r requirements.txt` | `python -m pytest -q` | CLOUD-VERIFIED 36/36 (CI on Python 3.11: success) | Windows pending; optional (research only) |
| Browser (Playwright) suites | Playwright + Chromium | `monitor.e2e.js`, `status.e2e.js` | CLOUD-VERIFIED 78/78 and 23/23 | Playwright is not a project dependency; Windows needs `npm.cmd i -g playwright` first; optional |
| FORWARD worker start, health, build identity | `npm start` | cloud: started, `/api/runtime` shows revision and FORWARD | CLOUD-VERIFIED (worker restarted several times this session after container resets; ledger verified) | Windows pending |
| News end to end (source -> store -> API -> screen) | network egress | cloud: 7/7 sources, 142 items, filters and cards in a real browser; static snapshot built | CLOUD-VERIFIED; public site after the merge: see session report | GitHub's runners may be refused by a source |
| TEST worker with the synthetic fixture | second port and its own database | started by `monitor.e2e.js` on 8792 with a temp database | CLOUD-VERIFIED; never pointed at the forward database | Windows pending (previous docs mention 8791; the suite uses 8792) |
| Multi-hour soak / weeks of forward evidence (B-05) | a PC that stays on | leave `npm.cmd start` running | NOT POSSIBLE here (container restarts); needs your PC | WINDOWS-ONLY |
| Model training visibility (Model Lab) | registry files | `/api/registry` shows `research/registry` | CLOUD-VERIFIED (REJECTED states shown) | training itself needs Python on whichever machine runs it |

## Exact commands to run on your laptop (PowerShell; use `npm.cmd`, do not change the execution policy)
```powershell
cd C:\Users\ASUS\Projects\crypto-monitor-local
git remote -v                         # expect: origin https://github.com/Art3mis9732/alexismeta
git status                            # note any local changes; do not discard them
git branch --show-current
git pull --ff-only origin main      # only if git status shows nothing to commit; it refuses rather than overwrite anything
node --version                        # need v22.23.0 or later
npm.cmd --version
Get-Content package.json -TotalCount 12
npm.cmd test                          # expect: "# pass 255" and "# fail 0" (about 1-2 minutes)
npm.cmd run smoke                     # 30 s live check; expect a pass report, no FAIL lines
npm.cmd start                         # leave this window open; expect "listening" on 8787
```
Healthy output: the `npm.cmd start` window prints lines like `paper engine running (FORWARD)` and `news: ...`; in a second PowerShell window `curl.exe -s http://127.0.0.1:8787/api/runtime` prints JSON with `"environment":"FORWARD"`; http://127.0.0.1:8787 opens the dashboard with the **News** tab showing items and price reactions.
Logs: the `npm.cmd start` window is the log. To keep a copy: `npm.cmd start 2>&1 | Tee-Object -FilePath worker.log`.
Stop safely: press **Ctrl+C** once in the `npm.cmd start` window (it flushes and closes the database). Do not close the window or kill the process while a position is open.
Backup (while running): `node server\admin.js backup data\backups\today.db`; verify the ledger: `node server\admin.js verify-ledger`; status: `node server\admin.js status`.
Resume after a stop: run `npm.cmd start` again; the downtime is recorded as a data gap, and open positions are managed by their recorded stops and targets.
Send me: the output of the commands above (or a screenshot). I will then reclassify the WINDOWS-ONLY rows.

## Not done / still needs you
* Everything labelled WINDOWS-ONLY above.
* The worker must run on a machine that stays on to collect news, order-book and forward evidence; the cloud container does not.
* Playwright is not installed by the project; the browser suites are optional on Windows.
