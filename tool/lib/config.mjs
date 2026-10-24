import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readJson } from './util.mjs';

export const TOOL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const KIT_VERSION = '0.3.2';

export function resolveRepo(env = process.env, cwd = process.cwd()) {
  if (env.MTM_REPO) return { repo: path.resolve(env.MTM_REPO), isRepo: true };
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return { repo: path.resolve(top), isRepo: true };
  } catch {
    return { repo: path.resolve(cwd), isRepo: false };
  }
}

/**
 * Config precedence: env vars > <repo>/.mtm/session.json > gm.config.json.
 * gm.config.json ships with baseUrl and matchId set to null, so a match never runs
 * against rehearsal defaults by accident. The token value is never printed.
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const file = env.MTM_CONFIG ? path.resolve(env.MTM_CONFIG) : path.join(TOOL_DIR, 'gm.config.json');
  const cfg = readJson(file);
  const { repo, isRepo } = resolveRepo(env, cwd);
  const runtimeDir = path.join(repo, '.mtm');
  const session = readJson(path.join(runtimeDir, 'session.json'), {});
  const tokenEnv = cfg.auth?.tokenEnv || 'MTM_TOKEN';
  const envOverrides = [];
  if (env.MTM_BASE_URL && session.baseUrl && env.MTM_BASE_URL !== session.baseUrl) envOverrides.push('MTM_BASE_URL');
  if (env.MTM_MATCH_ID && session.matchId && env.MTM_MATCH_ID !== session.matchId) envOverrides.push('MTM_MATCH_ID');
  let tokenSource = null;
  if (env[tokenEnv]) tokenSource = `env ${tokenEnv}`;
  else if (session.token) tokenSource = '.mtm/session.json';
  return {
    ...cfg,
    baseUrl: env.MTM_BASE_URL || session.baseUrl || cfg.baseUrl || null,
    matchId: env.MTM_MATCH_ID || session.matchId || cfg.matchId || null,
    token: env[tokenEnv] || session.token || null,
    tokenSource,
    tokenEnv,
    envOverrides,
    planner: { ...(cfg.planner || {}), ...(session.planner || {}) },
    repo,
    isRepo,
    runtimeDir,
    configFile: file,
  };
}
