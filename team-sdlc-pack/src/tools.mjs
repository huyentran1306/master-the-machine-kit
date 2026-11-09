// Tool catalogue exposed over MCP. Names follow the technical guide's helper table, plus a few
// helpers that keep the model's token use low (recon, planner view, final result, worktrees).
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const key = { type: 'string', description: 'Backlog ID exactly as on /match, e.g. BUG-01' };

export const TOOLS = [
  {
    name: 'configure_session',
    description: 'Give the helper the mtm-player lifecycle input. Pass `raw` = the full input text INCLUDING its marker line (PREPARE_GAME_V2, START_GAME_V4, RESUME_PREPARATION_V1, RESUME_GAME_V1, MATCH_PAUSED_V1, MATCH_ENDED_V1) and the MTM_MODEL_POLICY_V1 part. Credentials stay in helper memory. Logs ORCHESTRATOR_STARTED/RESTARTED; on START/RESUME_GAME also runs BACKLOG_SYNC and returns the backlog view. Faster START: when this session already ran PREPARE_GAME_V2 for the same match, raw may be only the START_GAME_V4 marker line and its JSON without checkoutRoot, matchRoot, progressLogFile, teamWorkspace, teamSdlcPackWorkspace and challengeWorkspace, and without the MTM_MODEL_POLICY_V1 part; the helper reuses them. Copy every other field exactly.',
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
    description: 'Wait for Game Master events. With active workers: wait_agent <=20s, shortened to the next cutoff. Service a completion immediately; only after a timeout call this with timeoutMs:1000. When a known reveal is due within 45s, call this instead of wait_agent. Never use generic wait. Without workers omit timeoutMs. Never end the turn while the match runs.',
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
    description: 'POST Start Work for OPEN items. Pass backlogItemKeys to overlap material reads (bounded concurrency). Default compact:true writes full worker brief/files and draft answer, returning only dispatch metadata and paths. compact:false retains full material in the result. Idempotent; logs IN_PROGRESS and BACKLOG_TESTS NOT_RUN.',
    inputSchema: obj({ backlogItemKey: key, backlogItemKeys: { type: 'array', items: key }, compact: { type: 'boolean', default: true }, matchUuid: { type: 'string', description: 'Only if the view says the match UUID is unknown and you read it from pageText.' } }),
    handler: (s, a) => s.start_work(a),
  },
  {
    name: 'submit_work',
    description: 'Submit ONE time per item. Preflight: started, open, full SHA pushed to the assigned branch, <folder>/answers/<ID>/submit.json and every "evidence/<file>" present IN THAT COMMIT, no root evidence folders, CR/BUG evidence. Sends the committed submit.json as answer (gitRevision field filled if the template has one) with a fixed clientSubmissionId/Idempotency-Key; retries the same body on timeout. Logs SUBMITTED only with the official receipt. Use dryRun to check first.',
    inputSchema: obj({ backlogItemKey: key, gitRevision: { type: 'string', description: 'Full SHA of the pushed commit (default: HEAD of the checkout).' }, dryRun: { type: 'boolean' }, allowNoEvidence: { type: 'boolean', description: 'Only if the item really has no MVS evidence requirement.' }, allowUntested: { type: 'boolean', description: 'Only if the item has no runnable test at all (pure UI tweak). Downgrades the test gate to a warning.' },
      allowMissingEvidence: { type: 'array', items: { type: 'string' }, description: 'Last resort: exact extracted names that are demonstrably extraction mistakes; requires reason.' },
      allowNoDescription: { type: 'boolean', description: 'Only when the match page truly has no text for this item: submit although its item text was never read.' },
      allowBlocked: { type: 'boolean', description: 'Last minutes only: permit BLOCKED/all-NOT_RUN/FAIL/zero cases; requires reason. Other gates still apply.' },
      reason: { type: 'string', description: 'Explain each extraction mistake or last-minute blocked override; retained in submission warnings/state.' },
    }, ['backlogItemKey']),
    handler: (s, a) => s.submit_work(a),
  },
  {
    name: 'report_progress',
    description: 'Append one progress event (schema-validated; envelope added). Use for PREPARATION_STATUS (GIT_AUTH/REPOSITORY/ENVIRONMENT/BUILD), BACKLOG_TESTS (real counts), BACKLOG_STATUS READY/COMPLETED or PARKED/BLOCKED (preserves commit + remainingStep), FAILED, BLOCKER_OPENED/RESOLVED, TOOL_ACTIVITY. Helper-owned events are refused.',
    inputSchema: obj({ remainingStep: { type: 'string', description: 'PARKED/BLOCKED: remaining work only; commit goes in event.revision.' }, remainingMinutes: { type: 'number' }, event: { type: 'object', description: 'e.g. {"type":"BACKLOG_TESTS","backlogId":"BUG-01","status":"PASSED","required":3,"executed":5,"passed":5,"failed":0,"skipped":0,"summary":"3 MVS + 2 edge tests passed."}' } }, ['event']),
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
      description: 'Read-only source recon of matchRoot: commands, stack and files. Create the ignored .mtm-notes/repo-map.md preparation snapshot once; return repoMapPath for routes, procedures, models, tests and exports.',
    inputSchema: obj({}),
    handler: (s) => s.recon_repo(),
  },
  {
    name: 'build_slot',
    description: 'Orchestrator-owned FIFO build/production leases shared across workers and integration. Acquire before next build or production start; launch only when granted. Release after build exits or production server stops. Relay grants to workers; never create a separate worker helper session.',
    inputSchema: obj({ action: { type: 'string', enum: ['acquire', 'release', 'status'] }, backlogItemKey: key }, ['action', 'backlogItemKey']),
    handler: (s, a) => s.build_slot(a),
  },
  {
    name: 'ship',
    description: 'READY -> SUBMITTED in ONE call: integrate (if needed) -> gate -> BACKLOG_TESTS from the gate run -> git push (fast-forward only) -> submit_work -> worktree remove. Calls are serialized. Stops and returns {stage, error, next} on any refusal: CONFLICT/MAIN_DIRTY at integrate, CODE_FAILURE at gate (roll back + worker fix-up), ENVIRONMENT at gate (retry, or force:true to submit the worker-verified commit), push rejection, submit preflight errors. Use it for every READY item instead of the separate steps. A ship still running after ~20 s returns stage:"shipping" and continues in the background (its result comes as a SHIP_RESULT event from wait_for_update), so you can ship other READY items meanwhile; a PI or a deadline within 5 min interrupts an ordinary gate.',
    inputSchema: obj({ backlogItemKey: key, force: { type: 'boolean', description: 'Only after an ENVIRONMENT gate verdict: submit the worker-verified commit anyway.' } }, ['backlogItemKey']),
    handler: (s, a) => s.ship(a),
  },
  {
    name: 'gate',
    description: 'Integration gate for an integrated item, run by the helper: direct vitest/tsc (no pnpm), the item\'s own test files for deadline items, time box that leaves a minute to push and submit. verdict GREEN -> push + submit_work; CODE_FAILURE -> worktree rollback + worker fix-up; ENVIRONMENT (timeout/hang/tool noise) -> never roll back, retry once or submit the worker-verified commit. Logs in .mtm-notes/gate-<ID>-*.log.',
    inputSchema: obj({ backlogItemKey: key, full: { type: 'boolean', description: 'Force the full suite even for a deadline item.' } }, ['backlogItemKey']),
    handler: (s, a) => s.gate(a),
  },
  {
    name: 'dispatch_ready',
    description: 'Dispatch EVERY open item in one call: start_work + worktree create for each item that has no worker (new reveals, PI, parked resumes, workers lost in a restart), within the RAM/code-worker policy. Returns spawn[] = {taskName, message}: spawn one team_feature_worker per entry in the same turn. Call it whenever the view shows DISPATCH NOW, but not when configure_session/ship already returned spawn entries.',
    inputSchema: obj({}),
    handler: (s) => s.dispatch_ready(),
  },
  {
    name: 'worktree',
    description: 'Worker lifecycle: create isolated worktree/brief with unique dev/production ports (PI bypasses caps; other answer-only uses maxAnswerWorkers; code uses RAM and maxCodeWorkers); integrate clean worker commits; rollback a failed unsubmitted integration using revert commits; remove; list. Never commits unfinished worker files.',
    inputSchema: obj({ action: { type: 'string', enum: ['create', 'integrate', 'rollback', 'remove', 'list'] }, backlogItemKey: key, message: { type: 'string', description: 'Legacy argument; worker supplies its own commit message.' } }, ['action']),
    handler: (s, a) => s.worktree(a),
  },
  {
    name: 'match_mcp',
    description: "The match's own MCP server, when the organizers provide one (the customer's internal material: standards, fixtures, tickets, documentation). action 'tools' lists what it offers, 'call' runs one (name + args), 'resource' reads a uri. Use it when a backlog item refers to an internal standard/fixture/ticket instead of assuming it is unavailable. The URL comes from the match page or game-adapter.json; the helper never guesses one.",
    inputSchema: obj({ action: { type: 'string', enum: ['tools', 'call', 'resource'] }, name: { type: 'string' }, args: { type: 'object' }, uri: { type: 'string' }, backlogItemKey: { ...key, description: 'For a follow-up: persist the raw result in this started item’s brief/files and mcpMaterial.' } }),
    handler: (s, a) => s.match_mcp(a),
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
