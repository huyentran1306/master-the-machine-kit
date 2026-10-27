// Builds mtm-player lifecycle inputs (wire marker + JSON line) exactly as documented in the
// technical guide, for rehearsals and tests.
import crypto from 'node:crypto';
import path from 'node:path';

const fwd = (p) => p.replace(/\\/g, '/');

export function modelPolicy({ model = 'gpt-5-codex', allowed } = {}) {
  return {
    schemaVersion: 1, orchestratorModel: model, allowedModels: allowed || [model], enforcement: 'TEAM_RESPONSIBILITY',
    catalogSource: 'rehearsal', catalogFetchedAt: new Date().toISOString(), instruction: 'Use only allowedModels for the orchestrator and every subagent.',
  };
}

export function baseFields(meta, { playerSessionId, origin }) {
  const checkoutRoot = path.join(meta.workspace, 'matches', meta.folder);
  return {
    schemaVersion: 1, playerSessionId, teamId: meta.teamId, teamName: meta.teamName, matchId: meta.folder,
    repository: { url: meta.repoUrl, branch: meta.branch, folder: meta.folder },
    checkoutRoot: fwd(checkoutRoot), matchRoot: fwd(path.join(checkoutRoot, meta.folder)), origin,
  };
}

export function prepareGame(meta, { playerSessionId, origin, username, password, requestId = 'prepare-1' }) {
  const b = baseFields(meta, { playerSessionId, origin });
  return {
    schemaVersion: 1, playerSessionId, teamId: b.teamId, teamName: b.teamName, matchId: b.matchId, type: 'PREPARE_GAME', requestId,
    username, password, matchPageUrl: `${origin}/match`, allowedMatchOrigins: [origin], repository: b.repository,
    hostAuthorization: {
      schemaVersion: 1, type: 'MTM_PREPARATION_HOST_AUTHORIZATION', authority: 'ORGANIZER_DECLARED_SCOPE', playerSessionId, matchId: b.matchId,
      inheritance: 'ORCHESTRATOR_TREE', enforcement: 'TEAM_RESPONSIBILITY', taskPermissions: 'INHERIT', credentialUse: 'HOST_GIT_CREDENTIAL_TO_ASSIGNED_REPOSITORY_ONLY',
      repository: b.repository, gitOperations: ['READ_ASSIGNED_REPOSITORY', 'CLONE_ASSIGNED_BRANCH', 'FETCH_ASSIGNED_BRANCH'],
    },
    checkoutRoot: b.checkoutRoot, matchRoot: b.matchRoot,
  };
}

function gameAccess(meta, { playerSessionId, origin, apiKey, teamUuid, environmentRevision }) {
  const b = baseFields(meta, { playerSessionId, origin });
  return {
    teamUuid, gameMasterApiUrl: `${origin}/`, apiKeySecret: apiKey, apiKeyLength: Buffer.byteLength(apiKey, 'utf8'),
    apiKeySha256: crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex'), apiKeyScopes: ['backlogs:start', 'submissions:create'],
    gameMasterUrl: `${origin}/`, matchPageUrl: `${origin}/match`, teamInfoRequestId: 'team-info-1', allowedApiOrigins: [origin],
    teamWorkspace: fwd(meta.workspace), challengeWorkspace: fwd(path.join(meta.workspace, 'matches')), teamSdlcPackWorkspace: fwd(path.join(meta.workspace, 'team-sdlc-pack')),
    progressLogFile: fwd(path.join(meta.workspace, 'team-sdlc-pack', 'logs', `${meta.folder}.progress.ndjson`)), environmentRevision,
    hostAuthorization: {
      schemaVersion: 1, type: 'MTM_HOST_AUTHORIZATION', authority: 'ORGANIZER_DECLARED_SCOPE', playerSessionId, matchId: b.matchId, inheritance: 'ORCHESTRATOR_TREE',
      enforcement: 'TEAM_RESPONSIBILITY', taskPermissions: 'INHERIT', credentialUse: 'TEAM_BEARER_TO_GAME_MASTER_ONLY', allowedOrigins: [origin], apiScopes: ['backlogs:start', 'submissions:create'],
      apiOperations: [
        { operation: 'START_WORK', method: 'POST', pathTemplate: '/api/v1/matches/{matchUuid}/backlogs/start' },
        { operation: 'SUBMIT', method: 'POST', pathTemplate: '/api/v1/matches/{matchUuid}/submissions' },
      ],
      gitOperations: ['COMMIT_ASSIGNED_REPOSITORY', 'PUSH_ASSIGNED_BRANCH'],
    },
    gitPolicy: { commitAssignedRepository: true, pushAssignedRepository: true, forcePush: false, mutateRemote: false, authentication: 'ASK_USER' },
    checkoutRoot: b.checkoutRoot, matchRoot: b.matchRoot,
  };
}

export function startGame(meta, o) {
  return { schemaVersion: 1, playerSessionId: o.playerSessionId, teamId: meta.teamId, teamName: meta.teamName, matchId: meta.folder, type: 'START_GAME', requestId: o.requestId || 'start-1', ...gameAccess(meta, o) };
}

export function resumeGame(meta, o) {
  const g = gameAccess(meta, o);
  return {
    schemaVersion: 1, playerSessionId: o.playerSessionId, teamId: meta.teamId, teamName: meta.teamName, matchId: meta.folder, type: 'RESUME_GAME',
    requestId: `restart-${o.playerSessionId}-${o.restartAttempt || 1}`, restartAttempt: o.restartAttempt || 1, reason: o.reason || 'OPERATOR_RESUME', teamUuid: o.teamUuid,
    username: o.username, password: o.password, gameMasterUrl: g.gameMasterUrl, matchPageUrl: g.matchPageUrl, allowedMatchOrigins: [o.origin],
    repository: { url: meta.repoUrl, branch: meta.branch, folder: meta.folder }, ...g,
  };
}

export function control(meta, type, playerSessionId) {
  return { schemaVersion: 1, type, playerSessionId, matchId: meta.folder, matchStatus: type === 'MATCH_PAUSED' ? 'PAUSED' : 'FINISHED' };
}

const MARKERS = { PREPARE_GAME: 'PREPARE_GAME_V2', START_GAME: 'START_GAME_V4', RESUME_PREPARATION: 'RESUME_PREPARATION_V1', RESUME_GAME: 'RESUME_GAME_V1', MATCH_PAUSED: 'MATCH_PAUSED_V1', MATCH_ENDED: 'MATCH_ENDED_V1' };

/** The prompt text an mtm-player-like launcher sends: marker line, JSON line, model-policy suffix. */
export function wire(descriptor, policy) {
  const lines = [MARKERS[descriptor.type], JSON.stringify(descriptor)];
  if (policy) lines.push('MTM_MODEL_POLICY_V1', JSON.stringify(policy));
  return lines.join('\n');
}
