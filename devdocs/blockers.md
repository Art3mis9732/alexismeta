# Blockers and open questions

| ID | Capability | Status | Minimum input needed | Independent work continuing |
|---|---|---|---|---|
| B-01 | Pushing work to GitHub from this ephemeral cloud container | **RESOLVED 2026-11-16: user approved pushing this feature branch only (no PR, merge or deploy).** Prompt P2§15 requires approval before any push. The container is reclaimed when idle, so unpushed commits can be lost. Pushing `claude/friendly-dirac-ouvgn4` triggers **no** workflow (snapshot.yml and tests.yml fire only on `main` or a PR) and opens no PR | A yes/no from the user on pushing this feature branch only (no merge, no PR, no deploy) | Yes: all local work |
| B-02 | Meaning of "Fable Advisor" | **RESOLVED 2026-11-16: user confirmed it is the Claude Code development reviewer, not a website feature.** | Confirmation, or a pointer to the code/feature | Yes |
| B-03 | Real Windows verification of the startup instructions | No Windows host is attached to this session | The user runs the PowerShell commands in `deployment-runbook.md` and reports the output | Yes |
| B-04 | Official definition of Bitget trade `side` (aggressor) | Not found in official classic docs (2026-11-16) | An official doc page, or a Bitget support answer | Yes: stored raw, flagged unverified (D-008) |
| B-05 | Multi-hour soak / multi-week forward evidence | Requires elapsed time on a machine that stays on | Running the worker on the user's PC | Yes |
