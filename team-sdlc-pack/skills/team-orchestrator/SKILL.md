---
name: team-orchestrator
description: Coordinates the Digital Project Team during an MTM match after START_GAME_V4 or RESUME_GAME_V1 - picks backlog work, delegates, integrates, tests, commits, pushes and submits until the match is FINISHED.
---

# Match loop (game phase)

Goal: the most PASSED points, fast, with few tokens. FAILED or unsubmitted = 0. PI is a race (100/90/75/60% by finishing order). Grader (an AI grader) also checks scenarios beyond MVS and reads your submit.json + evidence.

`configure_session` already ran BACKLOG_SYNC and returned the view. Every helper result carries `next`, `alerts`, `events` and `keepAlive`: obey `!!` alerts first.

## Loop
1. Take NEXT from the view. Nothing actionable -> `wait_for_update` (55 s), then repeat. Never end the turn while the match runs.
2. `start_work <ID>` (before any edit). Work happens in the application folder `recon_repo` reported as `app.path` (often `<matchRoot>/src`); `answers/` stays at `matchRoot`. The result names the playbook and, when the stack has one, a stack skill (`stack-nextjs-prisma`, else `stack-unknown`): read it once per match. It returns brief, startInstruction, submitTemplate, MVS, files, answer paths and the playbook. Read the playbook once: `.agents/skills/backlog-<pi|bug|cr|task>/SKILL.md`. The description is in the result; use `get_backlog_item` only if it is missing. **A backlog item with `title: null` is not a broken item** - the match page simply did not render a title the parser trusts. Call `get_backlog_item` for its text and work it normally; never skip or deprioritise an item because its title is missing.
2b. **Does the item point outside the repository?** A brief that names an internal standard, a QA fixture set, a ticket, a policy or "the official <something>" means the answer is not in the code. Call `match_mcp action:"tools"` once per match to see whether the organizers provide a match MCP server (the customer's internal material), then `action:"call"` to search it. Quote the document id you used in the answer. If there is no such server, or it does not have it: choose the most conventional interpretation, write it under assumptions, and ship. Never report an item as blocked because a reference was not available - an unsubmitted item scores 0.
3. Contract (1 minute, in `<checkoutRoot>/.mtm-notes/<ID>.md`, git-ignored): outcome; acceptance = every MVS line + 2-4 hidden scenarios; files in scope; assumptions. For a PI write only outcome + repro first.
4. Implement with the smallest correct change. Tests first where possible. Report `BACKLOG_TESTS` RUNNING, then PASSED/FAILED with real counts (`required` = MVS count).
4c. **Most items require the WHOLE suite and typecheck to pass, not just your new tests.** Run `pnpm test` (or the repo's full test command) and `pnpm typecheck` before submitting, every time. Compare against `.mtm-notes/baseline.md`: a failure that was already there is still a failure the acceptance criteria will count. If a baseline test contradicts the behaviour this item requires, the brief usually allows fixing that test - fix it and record what changed and why in the engineering record / analysis field. Never submit with a red suite and a note saying it was red before.
5. Evidence + answer: follow `.agents/skills/evidence-and-answer/SKILL.md`.
6. Review: for CR/BUG (and any item > 3 files) spawn `team_quality_checker` with the item, diff and commands; close every GAP with a test. Small TASK/PI: self-review in 3 lines.
7. Commit and push (separate commands, from checkoutRoot):
   `git -C "<checkoutRoot>" status --short` -> `git -C "<checkoutRoot>" add <files> "<folder>/answers/<ID>"` -> `git -C "<checkoutRoot>" commit -m "<ID>: <what>"` -> `git -C "<checkoutRoot>" push origin <branch>`.
   Push rejected: `git pull --rebase origin <branch>`, rerun the item's tests, push again. Never force-push.
8. `submit_work <ID>` (optionally `dryRun:true` first when unsure). It refuses with exact errors if anything is missing; fix, commit, push, call again. `UNCERTAIN` -> call `submit_work <ID>` again without changing anything (same idempotency key).
9. After `SUBMITTED`: do not wait for grading. Back to 1.

## Priorities and time
- PI first: when `!! PI <ID> revealed` appears, finish the current step, commit a tested state or `git stash push -u -m "WIP <ID>"`, and start the PI (unless NEXT says finish-first). After the PI is submitted, `git stash list` and pop your WIP.
- Then items whose deadline is near, then best points per minute. Targets: PI 10m, BUG 10m, TASK 8m, CR 14m.
- `!! WRAP UP` -> stop adding scope, ship what passes. `!! OVER BUDGET` -> submit what passes, or stash + mark parked (report BACKLOG_STATUS BLOCKED with a summary) and take NEXT. `!! ABANDON` -> stash as DEAD, take NEXT. Last 6 minutes: start nothing that cannot finish.
- Deadlines and the match clock are the Game Master's (helper view), never your machine clock.

## Parallel lane (when it pays)
Use when 2+ non-PI items are startable, the repo is ready, and the items touch different areas. Max 2 workers.
1. `start_work <ID2>` then `worktree create <ID2>` (it moves the draft `answers/<ID2>/` into the worktree; give the worker the `answer` paths it returns, never the main checkout's).
2. Spawn `team_feature_worker` with: ID, type, brief, startInstruction, MVS, template, worktreeRoot, matchRoot, time box (8-12 min). Keep working on your own item meanwhile.
3. When it reports: `worktree integrate <ID2> message:"<ID2>: <what>"` (your own work must be committed or stashed first), run its tests in the main checkout, optional `team_quality_checker`, push, `submit_work <ID2>`, `worktree remove <ID2>`.
4. Conflict -> integrate aborts and main is unchanged: redo the small change in main or resolve by hand.
Never parallelize a PI with its own investigation unless using `team_repo_scout` (read-only).

## Subagents
- `team_repo_scout` (read-only): PI root-cause hunt in parallel with your own search; CR requirement breakdown when the spec is long.
- `team_feature_worker`: parallel lane only, inside its worktree.
- `team_quality_checker` (read-only): CR/BUG review before commit.
Give each one a complete, self-contained prompt (paths, IDs, brief, MVS, commands). Never give credentials. If a subagent has not answered in its time box, continue without it. Note subagent use in the answer's collaboration field if the template has one.

## Shell (Windows PowerShell)
- One command per call, or `;` separators. Never `&&`/`||` (PowerShell 5.1). No head/tail/sed: `Select-Object -First N`, `Get-Content -Tail N`.
- Search with `rg -n` (fallback `git grep -n`). Open only needed ranges. Quote paths with spaces.
- Edit files with apply_patch. Never write JSON with Set-Content/Out-File (BOM/encoding problems).
- Single-quote args with `{}` or `-D...`: `'stash@{0}'`, `'-Dtest=FooTest'`.
- Long builds/tests: wait on the same session until done; do not start parallel copies.
- **`mustEnd` on any tool result means the match is over**: call `final_result {"end":true}` immediately. It writes ORCHESTRATOR_ENDED, the last event mtm-player waits for; until then the round stays open and looks unfinished. Nothing you do after the match ends can score.
- A `byte-identical to another item's evidence` warning from `submit_work` means a lane copied the wrong evidence folder: delete what does not belong to this item from `answers/<ID>/evidence/`, recommit, and submit. It is a warning, so you may still submit if time is short - but a grader reading another item's screenshots counts against the evidence.

## Never
- Submit twice, submit without start_work, or submit an unpushed commit.
- Stop because a "company standard", fixture or document is unavailable: choose the most conventional interpretation, write it under assumptions, ship.
- Spend more than 3 minutes fighting the environment (DB, browser, network): use the narrowest check that runs, mark scenarios you could not run as NOT_RUN with the reason, and ship.
- Edit `challenge/` files, `exam-info.json`, `env-require/`, other teams' folders, mtm-player files, or the pack.
- Commit `.env`, `node_modules`, build output, uploads or local data.
- End the turn while the match is IN_PROGRESS or PAUSED-without-input. On `!! MATCH FINISHED`: `final_result end:true`, reply with its `reply` JSON, stop.
