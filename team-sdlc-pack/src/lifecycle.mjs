// Parses mtm-player lifecycle input. The prompt contains wire markers, each followed by one JSON
// object (descriptor), plus an optional MTM_MODEL_POLICY_V1 suffix. Never parse the whole prompt
// as JSON: extract the object after each marker separately.
import crypto from 'node:crypto';
import path from 'node:path';
import { ID_RE, originOf, samePath, isInside, linkOnPath } from './util.mjs';

export const KNOWN_MARKERS = {
  PREPARE_GAME_V2: 'PREPARE_GAME',
  START_GAME_V4: 'START_GAME',
  RESUME_PREPARATION_V1: 'RESUME_PREPARATION',
  RESUME_GAME_V1: 'RESUME_GAME',
  MATCH_PAUSED_V1: 'MATCH_PAUSED',
  MATCH_ENDED_V1: 'MATCH_ENDED',
};
const MARKER_RE = /\b(PREPARE_GAME|START_GAME|RESUME_PREPARATION|RESUME_GAME|MATCH_PAUSED|MATCH_ENDED|MTM_MODEL_POLICY)_V(\d+)\b/g;

/** Extracts the balanced JSON object that starts at the first "{" at or after `from`. */
export function extractJsonObject(text, from = 0) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(raw), start, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Returns { inputs: [{ marker, version, type, descriptor }], modelPolicy, warnings }. */
export function parseLifecycleText(text) {
  const inputs = [];
  const warnings = [];
  let modelPolicy = null;
  const src = String(text ?? '');
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(src))) {
    const marker = m[0];
    const obj = extractJsonObject(src, m.index + marker.length);
    if (!obj) {
      warnings.push(`${marker}: no JSON object follows the marker`);
      continue;
    }
    if (m[1] === 'MTM_MODEL_POLICY') {
      modelPolicy = obj.value;
    } else {
      const type = m[1];
      if (!KNOWN_MARKERS[marker]) warnings.push(`${marker}: unknown version (expected one of ${Object.keys(KNOWN_MARKERS).filter((k) => k.startsWith(type)).join(', ')}); parsed anyway`);
      if (obj.value.type && obj.value.type !== type) warnings.push(`${marker}: descriptor.type is ${obj.value.type}`);
      inputs.push({ marker, version: Number(m[2]), type: obj.value.type || type, descriptor: obj.value });
    }
    MARKER_RE.lastIndex = obj.end;
  }
  if (!inputs.length && !modelPolicy) {
    // A bare descriptor object without a marker (some launchers strip it): accept by its type.
    const obj = extractJsonObject(src, 0);
    if (obj?.value?.type) inputs.push({ marker: null, version: null, type: obj.value.type, descriptor: obj.value });
  }
  return { inputs, modelPolicy, warnings };
}

const isStr = (v) => typeof v === 'string' && v.length > 0;

function needStrings(d, keys, errors) {
  for (const k of keys) if (!isStr(d[k])) errors.push(`${k} is required`);
}

function checkRepository(repo, errors, label = 'repository') {
  if (!repo || typeof repo !== 'object') {
    errors.push(`${label} is required`);
    return;
  }
  if (!/^https:\/\/[^@]+$/.test(repo.url || '')) {
    errors.push(`${label}.url must be an https URL without credentials`);
  }
  if (!isStr(repo.branch)) errors.push(`${label}.branch is required`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repo.folder || '')) errors.push(`${label}.folder is invalid`);
}

function sameRepo(a, b) {
  return a && b && a.url === b.url && a.branch === b.branch && a.folder === b.folder;
}

/**
 * Validates one descriptor against what the helper already knows.
 * ctx: { teamWorkspace, teamId, session: { playerSessionId, matchId, repository } }
 * Returns { errors, warnings }.
 */
export function validateDescriptor(d, ctx = {}) {
  const errors = [];
  const warnings = [];
  if (!d || typeof d !== 'object') return { errors: ['descriptor must be an object'], warnings };
  if (d.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  needStrings(d, ['type', 'playerSessionId', 'matchId'], errors);
  if (d.playerSessionId && !ID_RE.test(d.playerSessionId)) errors.push('playerSessionId has invalid characters');
  const type = d.type;
  if (['MATCH_PAUSED', 'MATCH_ENDED'].includes(type)) {
    if (ctx.session?.matchId && d.matchId !== ctx.session.matchId) errors.push(`matchId ${d.matchId} does not match the session (${ctx.session.matchId})`);
    return { errors, warnings };
  }
  needStrings(d, ['requestId', 'checkoutRoot', 'matchRoot'], errors);
  if (ctx.teamId && d.teamId && String(d.teamId).toLowerCase() !== String(ctx.teamId).toLowerCase()) {
    errors.push(`teamId ${d.teamId} differs from the installed pack identity ${ctx.teamId}`);
  }
  const needsAccount = ['PREPARE_GAME', 'RESUME_PREPARATION', 'RESUME_GAME'].includes(type);
  const needsBearer = ['START_GAME', 'RESUME_GAME'].includes(type);
  if (needsAccount) {
    needStrings(d, ['username', 'password', 'matchPageUrl'], errors);
    if (!Array.isArray(d.allowedMatchOrigins) || !d.allowedMatchOrigins.length) errors.push('allowedMatchOrigins is required');
    else if (d.matchPageUrl && !d.allowedMatchOrigins.includes(originOf(d.matchPageUrl))) errors.push('matchPageUrl origin is not in allowedMatchOrigins');
    checkRepository(d.repository, errors);
  }
  if (type === 'PREPARE_GAME') {
    const h = d.hostAuthorization;
    if (!h) errors.push('hostAuthorization is required');
    else {
      if (h.type !== 'MTM_PREPARATION_HOST_AUTHORIZATION') warnings.push(`hostAuthorization.type is ${h.type}`);
      if (h.playerSessionId !== d.playerSessionId) errors.push('hostAuthorization.playerSessionId mismatch');
      if (h.matchId !== d.matchId) errors.push('hostAuthorization.matchId mismatch');
      if (h.repository && !sameRepo(h.repository, d.repository)) errors.push('hostAuthorization.repository differs from repository');
    }
  }
  if (needsBearer) {
    needStrings(d, ['gameMasterApiUrl', 'apiKeySecret', 'apiKeySha256'], errors);
    if (isStr(d.apiKeySecret)) {
      const len = Buffer.byteLength(d.apiKeySecret, 'utf8');
      if (d.apiKeyLength != null && len !== d.apiKeyLength) errors.push(`apiKeySecret length ${len} != apiKeyLength ${d.apiKeyLength}`);
      const hash = crypto.createHash('sha256').update(d.apiKeySecret, 'utf8').digest('hex');
      if (isStr(d.apiKeySha256) && hash !== d.apiKeySha256.toLowerCase()) errors.push('apiKeySecret SHA-256 does not match apiKeySha256');
    }
    const apiOrigin = originOf(d.gameMasterApiUrl);
    if (!Array.isArray(d.allowedApiOrigins) || !d.allowedApiOrigins.includes(apiOrigin)) errors.push('gameMasterApiUrl origin is not in allowedApiOrigins');
    const h = d.hostAuthorization;
    if (!h) errors.push('hostAuthorization is required');
    else {
      if (h.playerSessionId !== d.playerSessionId) errors.push('hostAuthorization.playerSessionId mismatch');
      if (h.matchId !== d.matchId) errors.push('hostAuthorization.matchId mismatch');
      if (Array.isArray(h.allowedOrigins) && apiOrigin && !h.allowedOrigins.includes(apiOrigin)) errors.push('gameMasterApiUrl origin is not in hostAuthorization.allowedOrigins');
      const ops = Array.isArray(h.apiOperations) ? h.apiOperations.map((o) => o.operation) : [];
      for (const op of ['START_WORK', 'SUBMIT']) if (!ops.includes(op)) warnings.push(`hostAuthorization.apiOperations has no ${op}; using the documented path`);
      if (h.credentialUse && h.credentialUse !== 'TEAM_BEARER_TO_GAME_MASTER_ONLY') warnings.push(`credentialUse is ${h.credentialUse}`);
    }
    const scopes = (d.apiKeyScopes || []).join(' ');
    if (!/submissions?:create/.test(scopes)) warnings.push('apiKeyScopes lists no submission(s):create scope');
    if (d.gitPolicy && d.gitPolicy.forcePush) warnings.push('gitPolicy.forcePush is true; the pack never force-pushes anyway');
    if (d.gitPolicy && d.gitPolicy.pushAssignedRepository === false) warnings.push('gitPolicy forbids push: submissions need a pushed SHA');
  }
  // Paths: matchRoot = checkoutRoot/repository.folder, inside <TeamWorkspace>/matches.
  const folder = d.repository?.folder || ctx.session?.repository?.folder;
  if (isStr(d.checkoutRoot) && isStr(d.matchRoot) && folder && !samePath(d.matchRoot, path.join(d.checkoutRoot, folder))) {
    errors.push('matchRoot must equal checkoutRoot/repository.folder');
  } else if (!folder && isStr(d.checkoutRoot) && isStr(d.matchRoot) && !samePath(path.dirname(path.resolve(d.matchRoot)), d.checkoutRoot)) {
    errors.push('matchRoot must be a direct child of checkoutRoot');
  }
  const tw = d.teamWorkspace || ctx.teamWorkspace;
  if (tw && isStr(d.checkoutRoot) && !isInside(d.checkoutRoot, path.join(tw, 'matches'))) {
    errors.push('checkoutRoot is outside <TeamWorkspace>/matches');
  }
  if (tw) {
    // Guide: resolve paths and refuse symlinks/junctions. A link under the workspace (matches/, the
    // checkout, the match folder, logs/) could point anywhere, so it is refused even when lexically inside.
    for (const [name, p] of [['checkoutRoot', d.checkoutRoot], ['matchRoot', d.matchRoot], ['progressLogFile', d.progressLogFile]]) {
      if (!isStr(p)) continue;
      const link = linkOnPath(p, tw);
      if (link) errors.push(`${name} passes through a symlink/junction (${link}); links are refused inside the team workspace`);
    }
  }
  if (d.teamWorkspace && ctx.teamWorkspace && !samePath(d.teamWorkspace, ctx.teamWorkspace)) {
    warnings.push(`teamWorkspace ${d.teamWorkspace} differs from the installed workspace ${ctx.teamWorkspace}`);
  }
  if (isStr(d.progressLogFile) && tw && !isInside(d.progressLogFile, tw)) errors.push('progressLogFile is outside the team workspace');
  if (ctx.session?.matchId && d.matchId !== ctx.session.matchId && type === 'START_GAME') errors.push(`START_GAME for ${d.matchId} but the session prepared ${ctx.session.matchId}`);
  if (ctx.session?.repository && d.repository && !sameRepo(ctx.session.repository, d.repository)) warnings.push('repository differs from the prepared repository');
  return { errors, warnings };
}

/** Descriptor without secrets, safe to persist or return. */
export function publicDescriptor(d) {
  if (!d) return d;
  const { password, apiKeySecret, ...rest } = d;
  return { ...rest, ...(password ? { password: '[held in helper memory]' } : {}), ...(apiKeySecret ? { apiKeySecret: '[held in helper memory]' } : {}) };
}
