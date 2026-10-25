---
name: team-recovery
description: Recovers an MTM Digital Project Team after RESUME_GAME_V1/RESUME_PREPARATION_V1, an account switch, a helper restart, expired login, rejected key, uncertain submit, push rejection or merge conflict - reconcile first, never redo or double-submit.
---

# Recovery

Principle: the Game Master and the progress log are the record. Reconcile, then continue. Never resubmit an item that has a receipt; never start over.

## RESUME_GAME_V1 (replacement session, e.g. after the $50 account switch or operator resume)
`configure_session` (raw input) already logged ORCHESTRATOR_RESTARTED, re-read the log, logged in, synced and returned `recovery`:
1. `recovery.pending` lists unresolved submissions: call `submit_work <ID>` for each (it replays the identical body and key; no new submission is created).
2. `recovery.started` = started, not submitted. `recovery.dirty` = uncommitted files; `recovery.stashes` = stashes (`WIP <ID>` is yours from this match).
   - Dirty files belong to `recovery.current` (or the started item whose files they are). Read `<checkoutRoot>/.mtm-notes/<ID>.md`, finish, test, commit, push, submit.
   - `start_work <ID>` on an already-started item only replays its material (no second start).
3. Then continue the team-orchestrator loop. Never redo preparation steps.

## RESUME_PREPARATION_V1
Re-run only the preparation stages not COMPLETED (configure result `prep`), then login_match and report_ready.

## Helper restarted / NEED_PREPARE_INPUT / NO_ACCOUNT
`configure_session` answering `NEED_PREPARE_INPUT` (or a refresh error `NO_ACCOUNT`) means the helper process restarted and lost the login: call `configure_session` once with `raw` = the PREPARE_GAME_V2 input from earlier in this conversation followed by the START_GAME_V4 input. The helper sees that preparation already completed and only restores the login; it does not start a new round.
Otherwise a refresh error `NO_ACCOUNT` means the helper lost memory. Call `configure_session` with the most recent PREPARE_GAME_V2 or RESUME_* input from your context, then again with the START_GAME_V4 input. If neither is in context: report BLOCKER_OPENED `HELPER_STATE_LOST` and keep working on started items locally; submit when access returns.

## Login expired / page unreadable
The helper re-logs in automatically. Persistent failure: keep coding the current item, `wait_for_update` between steps; do not stop the turn.

## Team key rejected (INVALID_API_KEY, API_KEY_REVOKED, TEAM_NOT_IN_MATCH, FORBIDDEN)
The helper opens blocker `BEARER_REJECTED`. Do not retry in a loop. Continue local work; retry start/submit after `wait_for_update` shows a change or a new lifecycle input arrives.

## Submit outcomes
- `UNCERTAIN`: change nothing; call `submit_work <ID>` again (same key + body). Repeat after `wait_for_update` if the network is down.
- `REJECTED BACKLOG_NOT_STARTED`: `start_work <ID>`, then `submit_work <ID>`.
- `REJECTED ALREADY_SUBMITTED`: it is done; take NEXT.
- `REJECTED VALIDATION_ERROR/INVALID_SUBMISSION`: fix the named field in submit.json, commit, push, submit again.
- `REJECTED BACKLOG_ITEM_CLOSED` / `MATCH_NOT_ACCEPTING_SUBMISSIONS`: take NEXT / wait_for_update.

## Git trouble
- Push rejected (non-fast-forward): `git -C "<checkoutRoot>" pull --rebase origin <branch>`, rerun the item's tests, push. Never force-push.
- Rebase conflict: resolve keeping both changes, rerun tests, `git rebase --continue`. If hopeless within 3 minutes: `git rebase --abort`, then merge instead (`git pull --no-rebase`).
- Stash pop conflict: keep the pushed version, merge the WIP into it, rerun tests, then `git stash drop 'stash@{N}'`. Never `git reset --hard` while a WIP stash or conflict exists.
- Auth prompt on push: BLOCKER_OPENED `GIT_AUTHENTICATION_REQUIRED`, keep working locally; mtm-player routes the approval.

## Approvals
Provider approval requests go through mtm-player. Stay alive while one is pending (`wait_for_update`). If rejected, report a blocker and choose an approach that does not need it.

## Blockers are information, not a stop
`BLOCKER_OPENED` tells mtm-player what is wrong; the loop continues. Resolve it (`BLOCKER_RESOLVED`, same blockerId) when it clears. Only an unrecoverable contract failure ends the session: `final_result status:FAILED end:true`.
