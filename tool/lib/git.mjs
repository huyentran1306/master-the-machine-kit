import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// No credential prompt may ever wait for a human during a match: fail fast instead.
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export function git(repo, args, { allowFail = false, timeoutMs = 30000, env, quietErr = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      // Large repos print thousands of CRLF warnings: never let stderr overflow the buffer.
      stdio: ['ignore', 'pipe', quietErr ? 'ignore' : 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV, ...(env || {}) },
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${msg || (e.code === 'ETIMEDOUT' ? 'timed out' : 'error')}`);
  }
}

/** False for a fresh clone of an empty remote (Game Master has not pushed the source yet). */
export function hasCommits(repo) {
  return git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFail: true }) !== null;
}

export function resolveRev(repo, rev = 'HEAD') {
  return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
}

export function treeOf(repo, rev) {
  return git(repo, ['rev-parse', `${rev}^{tree}`], { allowFail: true });
}

export function dirtyFiles(repo) {
  const out = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  return out ? out.split(/\r?\n/) : [];
}

/**
 * Tree id of the working directory as `git add -A` would commit it (tracked + untracked,
 * honouring .gitignore and info/exclude), computed in a throwaway copy of the index so the
 * real index and working tree are untouched. Lets submit prove the evidence ran on the
 * exact content of the submitted commit.
 */
export function workingTreeHash(repo) {
  const indexPath = git(repo, ['rev-parse', '--git-path', 'index'], { allowFail: true });
  if (!indexPath) return null;
  const real = path.resolve(repo, indexPath);
  const tmp = path.join(os.tmpdir(), `mtm-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (git(repo, ['add', '-A'], { allowFail: true, env, timeoutMs: 120000, quietErr: true }) === null) return null;
    return git(repo, ['write-tree'], { allowFail: true, env });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Upstream of the current branch, e.g. { remote: 'origin', branch: 'main' }, or null. */
export function upstreamOf(repo) {
  const up = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  if (!up || !up.includes('/')) return null;
  const i = up.indexOf('/');
  return { remote: up.slice(0, i), branch: up.slice(i + 1) };
}

function containsOnRemote(repo, sha, branch, remote) {
  if (branch) {
    return git(repo, ['merge-base', '--is-ancestor', sha, `${remote}/${branch}`], { allowFail: true }) !== null;
  }
  const out = git(repo, ['branch', '-r', '--contains', sha], { allowFail: true });
  return !!(out && out.trim());
}

/**
 * True when the commit is on the remote: on <remote>/<branch> when a branch is given,
 * otherwise on any remote-tracking branch. Fetches only when the local refs say no,
 * because the agent's own push already updated the remote-tracking ref.
 */
export function isPushed(repo, sha, { branch = null, remote = 'origin' } = {}) {
  if (containsOnRemote(repo, sha, branch, remote)) return true;
  git(repo, ['fetch', '--quiet', remote], { allowFail: true, timeoutMs: 60000 });
  return containsOnRemote(repo, sha, branch, remote);
}

export function aheadBehind(repo, remoteRef) {
  const out = git(repo, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], { allowFail: true });
  if (!out) return null;
  const [ahead, behind] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

export function pushDryRun(repo, remote, branch) {
  try {
    // --no-verify: a pre-push hook (husky running the whole suite) must not decide the rights check.
    execFileSync('git', ['push', '--dry-run', '--no-verify', '--porcelain', remote, `HEAD:refs/heads/${branch}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
    });
    return { ok: true };
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}`.trim();
    // A dry run of a non-fast-forward still proves write access; it only says we are behind.
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(msg)) return { ok: true, behind: true };
    return { ok: false, message: msg.split(/\r?\n/).slice(-3).join(' | ') || e.message };
  }
}

/** Proves the agent may write to .git (sandboxes can allow reads only). */
export function writeProbe(repo) {
  const ref = 'refs/mtm/probe';
  if (git(repo, ['update-ref', ref, 'HEAD'], { allowFail: true }) === null) return false;
  git(repo, ['update-ref', '-d', ref], { allowFail: true });
  return true;
}

/** Keeps .mtm/ out of the team repo without touching tracked files (works in linked worktrees). */
export function ensureExcluded(repo, entry = '.mtm/') {
  try {
    const rel = git(repo, ['rev-parse', '--git-path', 'info/exclude'], { allowFail: true });
    if (!rel) return false;
    const file = path.resolve(repo, rel);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split(/\r?\n/).includes(entry)) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${entry}\n`);
    return true;
  } catch {
    return false;
  }
}
