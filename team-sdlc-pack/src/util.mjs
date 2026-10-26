// Small shared helpers. Node built-ins only: the pack has no npm dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
export const SHA_RE = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
export const ITEM_KEY_RE = /^(TASK|CR|BUG|PI)-\d{1,4}$/;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const nowIso = () => new Date().toISOString();

/** One line, no CR/LF/NUL, 1..max chars: the shape the progress schema wants for summaries. */
export function oneLine(text, max = 240, fallback = 'Status updated.') {
  let s = String(text ?? '').replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = fallback;
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** A value usable where the schema wants an id, or null. */
export function safeId(v, max = 128) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return ID_RE.test(s) ? s : null;
}

export function truncate(s, max) {
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

/**
 * Identity of a Git remote across spellings: https://host/a/b(.git), ssh://git@host/a/b, git@host:a/b.git.
 * Returns { host, path } in lower case, path without leading/trailing slashes and without .git.
 */
export function repoKey(url) {
  const s = String(url ?? '').trim();
  let host = '';
  let p = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      p = decodeURIComponent(u.pathname);
    } catch { /* keep the raw text */ }
  } else {
    const scp = s.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
    if (scp && !/^[A-Za-z]:[\\/]/.test(s)) {
      host = scp[1];
      p = scp[2];
    }
  }
  p = p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  return { host: host.toLowerCase(), path: p.toLowerCase() };
}

/** Normalized absolute path for comparisons (case-insensitive on Windows). */
export function normPath(p) {
  const r = path.resolve(String(p));
  return IS_WIN ? r.replace(/\\/g, '/').toLowerCase() : r;
}

/**
 * Real path of p with every symlink/junction resolved. For a path that does not exist yet: the real
 * path of its deepest existing ancestor plus the remaining segments. Also folds aliases such as
 * macOS /var -> /private/var, so two spellings of one directory compare equal.
 */
export function realPathLoose(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function samePath(a, b) {
  return normPath(a) === normPath(b) || normPath(realPathLoose(a)) === normPath(realPathLoose(b));
}

/** True when child is inside (or equal to) parent after resolving real paths (links cannot escape). */
export function isInside(child, parent) {
  const c = normPath(realPathLoose(child));
  const p = normPath(realPathLoose(parent));
  return c === p || c.startsWith(p.endsWith('/') || p.endsWith(path.sep) ? p : p + (IS_WIN ? '/' : path.sep));
}

/**
 * First existing symlink/junction on the way from root (exclusive) down to target (inclusive), or null.
 * Root and target may be spelled through different aliases (macOS /var vs /private/var, a linked parent
 * directory): the walk starts at the highest ancestor of target whose real path is root's real path, so
 * the components below the root are checked as the target spells them, never pre-resolved.
 * Node reports Windows junctions as symbolic links too.
 */
export function linkOnPath(target, root) {
  const t = path.resolve(String(target));
  const rootReal = normPath(realPathLoose(root));
  let anchor = null;
  for (let cur = t; ; cur = path.dirname(cur)) {
    if (normPath(realPathLoose(cur)) === rootReal) anchor = cur; // keep climbing: the highest match wins
    if (path.dirname(cur) === cur) break;
  }
  if (!anchor) return null; // not under root at all: isInside reports it
  let cur = anchor;
  for (const part of path.relative(anchor, t).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return null; // does not exist yet: nothing below it can be a link
    }
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** Atomic-ish JSON write (temp file then rename). */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: the target may be briefly locked (antivirus/indexer); fall back to a direct write.
    fs.writeFileSync(file, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Origins mtm-player accepts in a log event: https, or http on loopback (so rehearsals against a
 * local mock produce the same events a real match does).
 */
export function loggableOrigin(url) {
  const o = originOf(url);
  if (!o || o.length > 256) return null;
  if (/^https:\/\/[^/?#]+$/.test(o)) return o;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o) ? o : null;
}

export function loggablePath(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/[^?#\\]*$/.test(p) && p.length <= 512 ? p : null;
  } catch {
    return null;
  }
}

/** Deep search for string values (used for evidence references). */
export function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

export function minutes(ms) {
  return ms == null ? null : Math.round((ms / 60000) * 10) / 10;
}

/** Remove secret-looking values before anything reaches a log or a tool result. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) if (sec && sec.length >= 4) s = s.split(sec).join('[REDACTED]');
  return s;
}
