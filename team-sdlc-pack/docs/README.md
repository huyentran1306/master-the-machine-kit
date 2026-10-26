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
