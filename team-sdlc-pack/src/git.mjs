// Git checks used by the helper. Network-free except lsRemote (fallback). The helper never
// pushes, never force-pushes and never changes remotes: the orchestrator does commits/pushes in
// its own shell where mtm-player can see and approve them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

export function git(cwd, args, { timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, env: ENV, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!err?.killed });
    });
    if (input != null) child.stdin.end(input);
  });
}

const posix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

export async function revParse(cwd, ref) {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isAncestor(cwd, sha, ref) {
  const r = await git(cwd, ['merge-base', '--is-ancestor', sha, ref]);
  return r.code === 0;
}

export async function remoteTrackingHead(cwd, branch) {
  return revParse(cwd, `refs/remotes/origin/${branch}`);
}

export async function lsRemote(cwd, branch) {
  const r = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`], { timeoutMs: 20000 });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(0, 300) };
  const sha = r.stdout.trim().split(/\s+/)[0] || null;
  return { ok: true, sha };
}

export async function existsAt(cwd, sha, relPath) {
  const r = await git(cwd, ['cat-file', '-e', `${sha}:${posix(relPath)}`]);
  return r.code === 0;
}

export async function fileAt(cwd, sha, relPath) {
  const r = await git(cwd, ['show', `${sha}:${posix(relPath)}`]);
  return r.code === 0 ? r.stdout : null;
}

export async function statusPorcelain(cwd, pathspec) {
  const r = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', ...(pathspec ? ['--', pathspec] : [])]);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/** Is `sha` reachable from the pushed branch? Uses the remote-tracking ref first (updated by push), ls-remote second. */
export async function pushedState(cwd, sha, branch) {
  const tracking = await remoteTrackingHead(cwd, branch);
  if (tracking && (tracking === sha || await isAncestor(cwd, sha, tracking))) return { pushed: true, via: 'origin tracking ref', remoteHead: tracking };
  const ls = await lsRemote(cwd, branch);
  if (ls.ok && ls.sha) {
    if (ls.sha === sha) return { pushed: true, via: 'ls-remote', remoteHead: ls.sha };
    const known = await revParse(cwd, ls.sha);
    if (known && await isAncestor(cwd, sha, ls.sha)) return { pushed: true, via: 'ls-remote', remoteHead: ls.sha };
    return { pushed: false, remoteHead: ls.sha, reason: known ? 'commit is not on the remote branch' : 'remote branch moved to a commit not fetched locally (git fetch, then rebase/merge)' };
  }
  return { pushed: false, remoteHead: tracking, reason: ls.ok ? 'remote branch not found' : `cannot reach remote: ${ls.error}` };
}

/** Make sure a path is excluded from git status without touching tracked files (.git/info/exclude). */
export function ensureExcluded(checkoutRoot, pattern) {
  const file = path.join(checkoutRoot, '.git', 'info', 'exclude');
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(pattern)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
    }
    return true;
  } catch {
    return false;
  }
}

export async function worktreeAdd(checkoutRoot, wtPath, branch, base = 'HEAD') {
  return git(checkoutRoot, ['worktree', 'add', '-B', branch, wtPath, base], { timeoutMs: 120000 });
}

export async function worktreeRemove(checkoutRoot, wtPath) {
  const r = await git(checkoutRoot, ['worktree', 'remove', '--force', wtPath], { timeoutMs: 60000 });
  await git(checkoutRoot, ['worktree', 'prune']);
  return r;
}

export async function commitAll(cwd, message, identity) {
  const add = await git(cwd, ['add', '-A']);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() };
  const staged = await git(cwd, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return { ok: false, error: 'nothing to commit' };
  const idArgs = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
  const c = await git(cwd, [...idArgs, 'commit', '--no-verify', '-m', message], { timeoutMs: 60000 });
  if (c.code !== 0) return { ok: false, error: (c.stderr || c.stdout).trim().slice(0, 500) };
  return { ok: true, sha: await revParse(cwd, 'HEAD') };
}

export async function cherryPick(cwd, sha) {
  const r = await git(cwd, ['cherry-pick', sha], { timeoutMs: 120000 });
  if (r.code === 0) return { ok: true, sha: await revParse(cwd, 'HEAD') };
  const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  await git(cwd, ['cherry-pick', '--abort']);
  return { ok: false, conflicts, error: (r.stderr || r.stdout).trim().slice(0, 500) };
}

export async function userIdentity(cwd) {
  const name = (await git(cwd, ['config', 'user.name'])).stdout.trim();
  const email = (await git(cwd, ['config', 'user.email'])).stdout.trim();
  return name && email ? { name, email } : null;
}
