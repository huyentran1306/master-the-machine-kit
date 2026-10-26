---
name: game-preparation
description: Prepares an MTM match after PREPARE_GAME_V2 or RESUME_PREPARATION_V1 - checks out the assigned repository, sets up and builds, logs in to the match page, then writes ENVIRONMENT_READY.
---

# Preparation (no backlog work, no push)

Budget: under 10 minutes. Humans may still be at the machine; a real blocker can still be fixed now.
`configure_session` returned `paths.checkoutRoot`, `paths.matchRoot`, the repository and the progress log. Use those exact paths.

Each stage: `report_progress` PREPARATION_STATUS `IN_PROGRESS` at the start, then `COMPLETED` only after real success, or `FAILED`/`BLOCKED` with a one-line reason. Example event:
`{"type":"PREPARATION_STATUS","stage":"GIT_AUTH","status":"IN_PROGRESS","summary":"Checking Git access to the assigned repository."}`

## 1. GIT_AUTH
`git ls-remote "<repository.url>" "refs/heads/<branch>"` must print a SHA. Uses the host Git credential; never put credentials in the URL or config.
Prompt/auth failure -> BLOCKED with blockerId `GIT_AUTHENTICATION_REQUIRED` (report_progress BLOCKER_OPENED), wait for operator approval through mtm-player, retry once, then BLOCKER_RESOLVED.

## 2. REPOSITORY
- No checkout yet: `git clone --branch <branch> --single-branch "<repository.url>" "<checkoutRoot>"`
- Checkout exists (new round or resume): `git -C "<checkoutRoot>" fetch origin <branch>`, then if `git -C "<checkoutRoot>" status --short` is not empty: `git -C "<checkoutRoot>" stash push -u -m "previous-round"`, then `git -C "<checkoutRoot>" checkout -B <branch> origin/<branch>`.
- Verify: `<matchRoot>` exists; `git -C "<checkoutRoot>" rev-parse HEAD` equals `git -C "<checkoutRoot>" rev-parse origin/<branch>`.
- If `git config user.name` / `user.email` are empty in the checkout, set them locally only: `git -C "<checkoutRoot>" config user.name "<teamId> DPT"` and `user.email "<teamId>@dpt.local"`.
- `git -C "<checkoutRoot>" config core.longpaths true` (Windows).
Do not commit or push during preparation.

## Match folder layout (what mtm-player gives you)
`matchRoot` = `<checkoutRoot>/<repository.folder>`. A match folder typically contains:
`README.md` (match-specific rules), `exam-info.json` (**immutable - never edit or commit a change to it**), `answers/` (empty; one subfolder per item), `env-require/` (environment setup: README.md, requirements.json, setup.ps1, db-setup.sql, prepare-source.ps1, doctor.ps1) and the application itself in `src/` (or whatever `recon_repo` reports as `app.path`).
Read `README.md` and `env-require/README.md` first: they state the real setup steps, ports and credentials policy. `recon_repo` returns `envelope`, `app` (install/build/test/typecheck commands) and `stackSkill`; if `stackSkill` is set, read `.agents/skills/<stackSkill>/SKILL.md` once.

## 3. ENVIRONMENT
- `recon_repo` -> envelope, app path, install/build/test/typecheck commands, env keys, DB/docker files.
- **If `env-require/` exists, follow its README exactly** - it is the match's own setup contract:
  1. Check the toolchain it names (`node --version`, `pnpm --version`, `git --version`, DB client). Missing user-level tool: `corepack enable pnpm`. Never install system software (DB server, JDK, SDK, browsers) during the match: the operator does that before the clock; report ENVIRONMENT BLOCKED naming what is missing.
  2. `<app.path>/.env.example` -> `.env` (copy, fill the placeholders the README describes; secrets stay local, never committed). Keep host/port/database names exactly as documented.
  3. Dependencies: `pnpm install --frozen-lockfile` (or the recon install command) in the app path - or run the provided `env-require/prepare-source.ps1`.
  4. Database, when the app needs one: apply migrations and seed as the README says (`pnpm exec prisma migrate deploy`, `pnpm db:seed`). The role/database are created by the operator with `db-setup.sql`; if that step is missing you cannot do it yourself - report BLOCKED.
  5. `pwsh -NoProfile -File env-require\doctor.ps1` (add `-SourceDir ..\<app.path>` when it differs). Only `Environment status: READY` counts. If it reports a missing privilege or component, report ENVIRONMENT BLOCKED with that exact line - do not change tests or app code to work around environment problems.
- No `env-require/`: install locked dependencies in the app path and continue.
- **Unfamiliar stack** (`recon_repo` -> `unknownStack: true`, or commands missing): read `.agents/skills/stack-unknown/SKILL.md` once. In short: the repository README, the CI workflow commands in `recon.ci`, the Makefile/scripts and the test runner config tell you the real install/build/test commands - use them verbatim, do not invent.

## 4. BUILD
- Run the build (or typecheck) and the unit test suite once (`pnpm build`, `pnpm typecheck`, `pnpm test`). Record in `<checkoutRoot>/.mtm-notes/baseline.md` (git-ignored by the helper): exact commands, duration, tests already failing (by name). Pre-existing test failures are normal (the backlog may be about them): BUILD is COMPLETED when the project builds/typechecks and the test runner runs.
- A step that needs an unavailable service (DB, external API) is not a build failure: note it in baseline.md, use the narrowest check that runs.
- COMPLETED summary example: "Build passed; 212 tests ran, 2 pre-existing failures recorded."

## 5. MATCH_LOGIN
`login_match`. It logs MATCH_LOGIN itself and verifies the match/team/repository shown on `/match/<matchId>`. Do not start any backlog item now. Failure -> retry once; still failing -> reply BLOCKED (step 7).

## 5b. Company knowledge (optional, 30 seconds)
`match_mcp action:"tools"`. If the match page advertises an MCP server, this lists what the customer's internal material offers (standards, QA fixtures, tickets); note the tool names in `.mtm-notes/baseline.md` so you do not rediscover them under time pressure. `NO_MATCH_MCP` is a normal answer: this match has none.

## 6. ENVIRONMENT_READY
`report_ready`. It writes ENVIRONMENT_READY (requestId, repository, HEAD revision, build PASS, matchLogin PASS) and returns `reply`. If it refuses, fix what it names and call it again.

## 7. End the turn
Reply with exactly the `reply` JSON from report_ready and nothing else. mtm-player validates the log, completes preparation with the server and later sends START_GAME_V4 as a new input.
If preparation cannot complete: reply `{"schemaVersion":1,"status":"BLOCKED","backlogs":[],"summary":"<what is blocked and what a human must do>"}` (use `final_result` with status BLOCKED).
