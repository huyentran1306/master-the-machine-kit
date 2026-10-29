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
   - Dirty files belong to `recovery.current` (or the started item whose files they are). Preserve them; dispatch a worker to recover, verify and commit in an isolated worktree. Never finish/debug item work in main.
   - `start_work <ID>` on an already-started item only replays its material (no second start).
3. Reconcile worktree list and live worker IDs before spawning replacements; preserve committed work. Then continue the team-orchestrator Quick card (do not re-read the whole skill). Never redo preparation steps.

## RESUME_PREPARATION_V1
Re-run only the preparation stages not COMPLETED (configure result `prep`), then login_match and report_ready.

## Helper restarted / NEED_PREPARE_INPUT / NO_ACCOUNT
`configure_session` answering `NEED_PREPARE_INPUT` (or a refresh error `NO_ACCOUNT`) means the helper process restarted and lost the login: call `configure_session` once with `raw` = the PREPARE_GAME_V2 input from earlier in this conversation followed by the START_GAME_V4 input. The helper sees that preparation already completed and only restores the login; it does not start a new round.
Otherwise a refresh error `NO_ACCOUNT` means the helper lost memory. Call `configure_session` with the most recent PREPARE_GAME_V2 or RESUME_* input from your context, then again with the START_GAME_V4 input. If neither is in context: report BLOCKER_OPENED `HELPER_STATE_LOST` and keep working on started items locally; submit when access returns.

## Login expired / page unreadable
The helper re-logs in automatically. Persistent failure: keep workers active locally and use the bounded worker/event wait loop; do not stop the turn.

## Team key rejected (INVALID_API_KEY, API_KEY_REVOKED, TEAM_NOT_IN_MATCH, FORBIDDEN)
The helper opens blocker `BEARER_REJECTED`. Do not retry in a loop. Continue local work; retry start/submit after `wait_for_update` shows a change or a new lifecycle input arrives.

## Submit outcomes
- A `submit_work` tool timeout or missing response is UNCERTAIN. Replay `submit_work <ID>` with the stored body/key; never recommit or change the answer to recover a timeout. `SUBMIT_IN_PROGRESS` means the original call still owns the item: wait, then replay. A stored receipt means it is already done.
- `UNCERTAIN`: change nothing; call `submit_work <ID>` again (same key + body). Repeat after `wait_for_update` if the network is down.
- `REJECTED BACKLOG_NOT_STARTED`: `start_work <ID>`, then `submit_work <ID>`.
- `REJECTED ALREADY_SUBMITTED`: it is done; take NEXT.
- `REJECTED VALIDATION_ERROR/INVALID_SUBMISSION`: delegate the named answer fix to a worker, integrate/gate, push and submit again.
- `REJECTED BACKLOG_ITEM_CLOSED` / `MATCH_NOT_ACCEPTING_SUBMISSIONS`: take NEXT / wait_for_update.

## Git trouble
- Push rejected (non-fast-forward): `git -C "<checkoutRoot>" pull --rebase origin <branch>`, run the bounded integration gate, push. Never force-push.
- Rebase conflict: abort; delegate resolution on a worktree from the updated remote/main base. Never repair item code in main (except a trivial one-line conflict).
- Legacy stash recovery: preserve the stash and delegate recovery into an isolated worktree. Never reset away saved work.
- Auth prompt on push: BLOCKER_OPENED `GIT_AUTHENTICATION_REQUIRED`, keep working locally; mtm-player routes the approval.

## Approvals
Provider approval requests go through mtm-player. Stay alive while one is pending (`wait_for_update`). If rejected, report a blocker and choose an approach that does not need it.

## Blockers are information, not a stop
`BLOCKER_OPENED` tells mtm-player what is wrong; the loop continues. Resolve it (`BLOCKER_RESOLVED`, same blockerId) when it clears. Only an unrecoverable contract failure ends the session: `final_result status:FAILED end:true`.
