---
name: backlog-task
description: Playbook for an MTM TASK-xx general assignment without MVS - do exactly what is asked (code, config, dependency or documentation work), verified, submit once.
---

# TASK: general assignment

No MVS; Grader still checks. Every template field hints at what is graded. Target ~8 minutes.

1. `start_work <ID>`. Notes: each concrete deliverable in the brief (code, endpoint, log/trace, config, doc line, file) as an acceptance line. Do all of them, including docs named in the brief (exact file name, no alias).
1b. If the brief points at something outside the repository (an internal document, ticket or fixture), search it with `match_mcp` before assuming it is unavailable.
2. Follow the repo's patterns (routing, naming, logging, error format, where version/config are read). Do not hardcode values the repo keeps elsewhere.
3. Tests for the new behaviour, including simple variants (missing input, query strings, trailing slash where the router accepts it). For data returned from module-owned objects/arrays, test that mutating a response does not change later responses.
4. Common TASK kinds:
   - Dependency vulnerabilities (production): `<pm> audit --prod` (recon `audit` command) BEFORE -> save the summary to `evidence/<ID>-audit-before.md`. Upgrade the minimum versions that fix production advisories (direct deps: bump in package.json within the same major when possible; transitive: `pnpm.overrides` / npm `overrides` / yarn `resolutions`). Reinstall to update the lockfile (`pnpm install --no-frozen-lockfile` / `npm install`). Audit AFTER -> `evidence/<ID>-audit-after.md`. Build + tests must still pass. List each package old -> new and the advisory it fixes. Do not touch dev-only advisories unless asked.
   - Tracing/logging/audit trail: log at the existing logger with the repo's format; include the IDs the brief names (e.g. card id, old/new position, column, actor); test that the log/record is produced.
   - Docs/config: exact file and section named; keep formatting.
5. Build/typecheck **and the full suite**, both green (acceptance usually names them). A pre-existing failure still counts; resolve it with the source-of-truth order (team-orchestrator Trap awareness): when the design records support the test, fix the code and keep the test; change a test only on an explicit, cited source. Report BACKLOG_TESTS. Self-review in 3 lines (or `team_quality_checker` if > 3 files).
6. Answer + evidence (evidence-and-answer skill). Commit `<ID>: <what>`, push, `submit_work <ID>`.
