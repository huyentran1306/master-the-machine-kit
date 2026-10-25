// Tool catalogue exposed over MCP. Names follow the technical guide's helper table, plus a few
// helpers that keep the model's token use low (recon, planner view, final result, worktrees).
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const key = { type: 'string', description: 'Backlog ID exactly as on /match, e.g. BUG-01' };

export const TOOLS = [
  {
    name: 'configure_session',
    description: 'Give the helper the mtm-player lifecycle input. Pass `raw` = the full input text INCLUDING its marker line (PREPARE_GAME_V2, START_GAME_V4, RESUME_PREPARATION_V1, RESUME_GAME_V1, MATCH_PAUSED_V1, MATCH_ENDED_V1) and the MTM_MODEL_POLICY_V1 part. Credentials stay in helper memory. Logs ORCHESTRATOR_STARTED/RESTARTED; on START/RESUME_GAME also runs BACKLOG_SYNC and returns the backlog view.',
    inputSchema: obj({ raw: { type: 'string' }, descriptor: { type: 'object' }, modelPolicy: { type: 'object' } }),
    handler: (s, a) => s.configure(a),
  },
  {
    name: 'login_match',
    description: 'Log in with the cookie session and open /match/<matchId>; verifies the assignment. In preparation it logs PREPARATION_STATUS MATCH_LOGIN.',
    inputSchema: obj({}),
    handler: (s) => s.login_match(),
  },
  {
    name: 'refresh_match',
    description: 'Re-read the match page: status, remaining time, backlog table, NEW/EDITED/CLOSED events, NEXT recommendation and alerts. Emits DISCOVERED for new items during the game.',
    inputSchema: obj({ includePageText: { type: 'boolean', description: 'Also return the visible page text (use when parsing is unclear).' } }),
    handler: (s, a) => s.refresh_match(a),
  },
  {
    name: 'wait_for_update',
    description: 'Bounded serial polling of the match page (<= 55 s). Returns early on any change (new item, state/edit, match status). Use whenever nothing is actionable. Never end your turn instead of calling this while the match runs.',
    inputSchema: obj({ timeoutMs: { type: 'integer', minimum: 1000, maximum: 55000 } }),
    handler: (s, a) => s.wait_for_update(a),
  },
  {
    name: 'get_backlog_item',
    description: 'Full detail of one item: description from the page, start material (instruction, template, MVS) if started, answer paths, time left.',
    inputSchema: obj({ backlogItemKey: key }, ['backlogItemKey']),
    handler: (s, a) => s.get_backlog_item(a),
  },
  {
    name: 'start_work',
    description: 'POST Start Work for one OPEN item (required before editing). Returns startInstruction, submitTemplate, MVS and on-start files; materializes <folder>/answers/<ID>/submit.json + evidence/; logs IN_PROGRESS and BACKLOG_TESTS NOT_RUN. Idempotent (replay).',
    inputSchema: obj({ backlogItemKey: key, matchUuid: { type: 'string', description: 'Only if the view says the match UUID is unknown and you read it from pageText.' } }, ['backlogItemKey']),
    handler: (s, a) => s.start_work(a),
  },
  {
    name: 'submit_work',
    description: 'Submit ONE time per item. Preflight: started, open, full SHA pushed to the assigned branch, <folder>/answers/<ID>/submit.json and every "evidence/<file>" present IN THAT COMMIT, no root evidence folders, CR/BUG evidence. Sends the committed submit.json as answer (gitRevision field filled if the template has one) with a fixed clientSubmissionId/Idempotency-Key; retries the same body on timeout. Logs SUBMITTED only with the official receipt. Use dryRun to check first.',
    inputSchema: obj({ backlogItemKey: key, gitRevision: { type: 'string', description: 'Full SHA of the pushed commit (default: HEAD of the checkout).' }, dryRun: { type: 'boolean' }, allowNoEvidence: { type: 'boolean', description: 'Only if the item really has no MVS evidence requirement.' } }, ['backlogItemKey']),
    handler: (s, a) => s.submit_work(a),
  },
  {
    name: 'report_progress',
    description: 'Append one progress event (schema-validated; envelope added). Use for PREPARATION_STATUS (GIT_AUTH/REPOSITORY/ENVIRONMENT/BUILD), BACKLOG_TESTS (real counts), BACKLOG_STATUS COMPLETED/BLOCKED/FAILED, BLOCKER_OPENED/RESOLVED, TOOL_ACTIVITY. Helper-owned events are refused.',
    inputSchema: obj({ event: { type: 'object', description: 'e.g. {"type":"BACKLOG_TESTS","backlogId":"BUG-01","status":"PASSED","required":3,"executed":5,"passed":5,"failed":0,"skipped":0,"summary":"3 MVS + 2 edge tests passed."}' } }, ['event']),
    handler: (s, a) => s.report_progress(a),
  },
  {
    name: 'report_ready',
    description: 'After GIT_AUTH, REPOSITORY, ENVIRONMENT, BUILD are COMPLETED and login_match passed: appends ENVIRONMENT_READY (requestId, repository, HEAD revision, build PASS, matchLogin PASS) and returns the preparation reply JSON.',
    inputSchema: obj({ summary: { type: 'string' } }),
    handler: (s, a) => s.report_ready(a),
  },
  {
    name: 'recon_repo',
    description: 'Compact repository map of matchRoot: package manager, install/build/test/typecheck/audit commands, frameworks, test tools, docker/env/db files, logs, docs, challenge files.',
    inputSchema: obj({}),
    handler: (s) => s.recon_repo(),
  },
  {
    name: 'worktree',
    description: 'Parallel lane for a started item: create (git worktree under <checkoutRoot>/.mtm-wt/<ID>, node_modules linked) for a team_feature_worker; integrate (commit the worktree and cherry-pick into the main checkout); remove; list.',
    inputSchema: obj({ action: { type: 'string', enum: ['create', 'integrate', 'remove', 'list'] }, backlogItemKey: key, message: { type: 'string', description: 'Commit message for integrate: "<ID>: <what>"' } }, ['action']),
    handler: (s, a) => s.worktree(a),
  },
  {
    name: 'session_status',
    description: 'Recovery snapshot: phase, preparation stages, credentials present (yes/no), started/unsubmitted items, unresolved submissions, dirty files, stashes, current view.',
    inputSchema: obj({}),
    handler: (s) => s.session_status(),
  },
  {
    name: 'final_result',
    description: 'Build the final result JSON (schemaVersion, status SUBMITTED|BLOCKED|FAILED, backlogs, summary). end=true also logs ORCHESTRATOR_ENDED (only at match end or unrecoverable failure; never for a pause).',
    inputSchema: obj({ status: { type: 'string', enum: ['SUBMITTED', 'BLOCKED', 'FAILED', 'COMPLETED'] }, summary: { type: 'string' }, end: { type: 'boolean' } }),
    handler: (s, a) => s.final_result(a),
  },
];
