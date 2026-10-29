# team-sdlc-pack internals

## Runtime
- `bin/runtime-server.mjs` — MCP Helper, stdio newline-delimited JSON-RPC (initialize, notifications/initialized, ping, tools/list, tools/call). stdout carries only JSON-RPC.
- `src/runtime-session.mjs` — lifecycle, credentials in memory, Game API, progress events, planner view, recovery state.
- `src/portal.mjs` — cookie login (NextAuth credentials → HTML form → JSON API, first that works; pin it in `config/game-adapter.json` after the practice match) and the `/match/<matchId>` parser (structured JSON in the page first, visible text as fallback; the match UUID comes from the Start/Submit URLs shown on the page).
- `src/game-api.mjs` — Start Work and Submit (`Idempotency-Key` = `clientSubmissionId`; retries reuse the identical body).
- `src/progress.mjs` + `contracts/progress-event.schema.json` — every event is validated against the organizer schema before it is appended; append failures are queued and retried in order.
- `src/planner.mjs` — order of work and time-box alerts on the Game Master clock.
- `src/answers.mjs` — `answers/<ID>/submit.json` + `answers/<ID>/evidence/` contract and preflight checks.
- `src/pack-contract.mjs` — identity/manifest/profile rules used by install and check.

## State
- Progress log: exactly `progressLogFile` (or `<TW>/team-sdlc-pack/logs/<matchId>.progress.ndjson` during preparation).
- Helper state (no secrets): `<checkoutRoot>/.git/mtm-team/state.json`, start material in `.git/mtm-team/items/<ID>/`; the agent's notes in `<checkoutRoot>/.mtm-notes/` (excluded via .git/info/exclude). Inside the assigned checkout, never committed.
- Credentials (password, team key, cookies): helper memory only.

## Tools
configure_session, login_match, refresh_match, wait_for_update, get_backlog_item, start_work, submit_work, report_progress, report_ready, recon_repo, match_mcp, worktree, session_status, final_result.

`match_mcp` speaks MCP over Streamable HTTP to the match's own MCP server (the customer's internal material), when the match page advertises one or `game-adapter.json` `matchView.mcpUrl` names it. The helper never guesses a URL, sends the team bearer, keeps the origin allowlist, and logs every call as NETWORK_ACTIVITY.

## Events written by the helper
ORCHESTRATOR_STARTED/RESTARTED (configure_session), PREPARATION_STATUS MATCH_LOGIN (login_match), ENVIRONMENT_READY (report_ready), GAME_START_STATUS BACKLOG_SYNC (START/RESUME_GAME), BACKLOG_STATUS DISCOVERED/IN_PROGRESS/SUBMITTED, BACKLOG_TESTS NOT_RUN (start), GAME_MASTER_API REQUESTED/SUCCEEDED/FAILED around every login, refresh, start and submit request, BLOCKER_OPENED/RESOLVED for helper-detected problems, ORCHESTRATOR_ENDED (final_result end=true / MATCH_ENDED).
The agent writes PREPARATION_STATUS for GIT_AUTH/REPOSITORY/ENVIRONMENT/BUILD, BACKLOG_TESTS RUNNING/PASSED/FAILED and its own blockers through `report_progress`.

## Dispatch contract (2.7.1)

Configure helper `parallel.maxWorkers` (default 3) and `parallel.portBase` (default 3100) in config/game-adapter.json before installation. PI may create one overflow worktree. Provider capacity must accommodate root + cap + one PI worker; release completed agents. Checker/scout remain optional, read-only, worker-requested assistance and must not consume reserved PI capacity.

Start Work defaults to compact mode. It writes the complete item/material, commands, installed skill paths, answer/checklist paths and workerStopAt into ignored .mtm-briefs/<ID>/brief.json; files preserve their relative imports. The response contains dispatch metadata and paths only. Use compact:false for legacy full material. worktree create rematerializes the brief inside the worktree, moves draft answers and remaps application/checklist paths; use only the returned worktree paths.

Start Work extracts `requiredEvidence: [{name, before}]` from item text, acceptance criteria, instruction, template and MVS. Both response modes and brief.json include it; checklist.md lists exact paths first. Workers save BEFORE artifacts before source edits on their own ports. After edits, capture a temporary copy of brief.baseSha within matchRoot instead of skipping the artifact.

Before dispatch, discover MCP tools by name/description/schema, retrieve per-item test data and search docs/KB with the item ID and terms. Keep raw responses and failures under ignored files/mcp/, indexed by brief.json mcpMaterial. Collection has a 30-second budget and 10-second waits per call; unavailable tools or unknown required arguments are recorded, not fatal. Reuse saved material on Start Work replay. worktree create also hydrates older material lacking this field. Read all brief/files/checklist material before returning NEED_INFO. For follow-ups, the orchestrator calls match_mcp with backlogItemKey to append raw results, then tells the worker to reread its brief.

submit_work and dryRun check the selected commit for every required regular evidence file and its exact reference in an `evidence` array. Broad allowNoEvidence/allowUntested flags cannot bypass named requirements. Last resort: `allowMissingEvidence:["name"]` plus a nonempty `reason` for an obvious extraction mistake only. BLOCKED and answers with every case NOT_RUN/FAIL/zero require `allowBlocked:true` plus `reason`; use only in the last minutes when nothing better exists. Prefer verified DONE/PARTIAL. Overrides remain in submission warnings/state; other gates and uncertain replay semantics stay unchanged.

Port pair n is dev=portBase+2n, production=dev+1. Persist allocation in helper state; do not recycle pairs during a session. Write ports into every worker brief. Workers must set explicit server ports and runner/browser URLs, keep browser profiles/build output local, and stop owned processes before READY/PARKED. The existing environment copy rewrites test DB names with an item suffix. Linked node_modules is read-only shared material; workers needing installs or client generation must replace only the link with a private install first.

Integrate only clean, worker-committed ranges. Replay the same READY SHA without cherry-picking twice. Keep the main gate <=2 minutes (full suite + typecheck; build when the worker lacks a passing build or build-relevant paths changed). Delegate slower integrated-tree checks and all repairs. On a failed unsubmitted gate, worktree rollback creates revert commits only while main still equals that integration; it refuses known pushed/pending/submitted integrations. Pass its retryBaseSha to the worker for rebase --onto <current-main-SHA> <retryBaseSha>, so reverted item commits are replayed. Check the exact integrated tree before push/submit. Never hold other READY work during repair.

With active workers, native agent wait <=45s then wait_for_update timeoutMs:1000 handles completion plus buffered Game Master events without an unsupported wait-any primitive. Shorten waits to worker cutoffs (deadline/match end minus 5 minutes). Check events between integrations too. With no workers, the helper waits up to 55s. Idle event latency is about 46s plus network latency; native completion wakes early. Read the orchestrator skill once; reminders read only the Quick card.
