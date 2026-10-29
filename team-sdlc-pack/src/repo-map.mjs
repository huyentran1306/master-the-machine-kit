// Bounded, best-effort localization snapshot. No dependencies, code execution or symlink traversal.
import fs from 'node:fs';
import path from 'node:path';
import { ensureExcluded } from './git.mjs';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target', 'bin', 'obj', 'venv', '__pycache__', 'answers']);
const clean = s => String(s).replace(/[\r\n\t]/g, ' ').slice(0, 450);
const exportsOf = text => [...new Set([
  ...[...text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g)].map(m => m[1]),
  ...[...text.matchAll(/\bexports\.(\w+)\s*=/g)].map(m => m[1]),
  ...[...text.matchAll(/\bexport\s*\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(s => s.trim())),
  ...[...text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)\b/gm)].map(m => m[1]),
  ...[...text.matchAll(/\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)|\bfunc\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/g)].map(m => m[1] || m[2]),
])].slice(0, 24);

export function buildRepoMap(matchRoot, recon = {}) {
  const files = [];
  let limited = false;
  function walk(dir, rel = '', depth = 0) {
    if (depth > 18 || files.length >= 6000) { limited = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), name, depth + 1);
      else if (e.isFile()) files.push(name);
      if (files.length >= 6000) { limited = true; break; }
    }
  }
  walk(matchRoot);
  const sections = { 'App and commands': [], 'Next.js routes (file -> URL)': [], 'tRPC routers': [], 'Services and exports': [], 'Prisma models and relations': [], 'Tests (top-level names)': [], 'Design records': [], 'Top-level directories (file counts)': [], 'Source exports (fallback)': [] };
  const add = (section, text) => {
    const rows = sections[section];
    if (rows.length < 38) rows.push(`- ${clean(text)}`);
    else if (rows.length === 38) rows.push('- … more entries omitted; confirm with rg.');
  };
  add('App and commands', `app root: ${recon.app?.path || '.'} (paths relative to assigned folder)`);
  for (const p of recon.node || (recon.app ? [recon.app] : [])) {
    add('App and commands', `${p.path}: ${['install', 'build', 'test', 'typecheck'].map(k => `${k}=${p[k] || '(not detected)'}`).join('; ')}`);
  }
  const counts = new Map();
  for (const file of files) {
    const top = file.includes('/') ? file.split('/')[0] + '/' : '(root files)';
    counts.set(top, (counts.get(top) || 0) + 1);
    if (/(?:^|\/)package\.json$/.test(file)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(matchRoot, file), 'utf8'));
        for (const [name, command] of Object.entries(pkg.scripts || {})) {
          if (/^(?:install|build|test|typecheck|type-check)(?::|$)/.test(name)) add('App and commands', `${file} :: ${name}: ${command}`);
        }
      } catch { /* malformed metadata must not interrupt preparation */ }
    }
    if (/(?:^|\/)(?:DECISIONS\.md|README(?:\.[^/]+)?)$|(?:^|\/)specs?(?:\/|\.)/i.test(file)) add('Design records', file);
    const route = file.match(/(?:^|\/)app\/(.*\/)?(page|route)\.[cm]?[jt]sx?$/);
    if (route) {
      const url = '/' + (route[1] || '').split('/').filter(s => s && !/^\(.+\)$|^@/.test(s)).join('/');
      add('Next.js routes (file -> URL)', `${file} -> ${url} (${route[2]})`);
    }
    if (!/\.(?:[cm]?[jt]sx?|prisma|py|go|rs|java|cs)$/.test(file) && !/(?:^|\/)tests\//.test(file)) continue;
    let text;
    try {
      const full = path.join(matchRoot, file);
      if (fs.statSync(full).size > 256 * 1024) { limited = true; continue; }
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    const symbols = exportsOf(text);
    if (symbols.length) add('Source exports (fallback)', `${file}: ${symbols.join(', ')}`);
    if (/(?:^|\/)(?:services?)(?:\/|\.)/.test(file)) add('Services and exports', `${file}: ${symbols.join(', ') || '(no exports detected)'}`);
    if (/(?:^|\/)server\/api\/routers\//.test(file)) {
      const names = [...text.matchAll(/\b(\w+)\s*:\s*(?:\w+\.)*\w*[Pp]rocedure\b[\s\S]{0,2000}?\.(?:query|mutation|subscription)\s*\(/g)].map(m => m[1]);
      add('tRPC routers', `${file}: ${names.join(', ') || '(confirm procedures with rg)'}`);
    }
    if (file.endsWith('.prisma')) {
      const models = [...text.matchAll(/^\s*model\s+(\w+)\s*\{([^}]+)\}/gm)];
      const names = new Set(models.map(m => m[1]));
      for (const m of models) {
        const relations = m[2].split(/\r?\n/).filter(l => names.has(l.trim().split(/\s+/)[1]?.replace(/[?\[\]]/g, '')) || /@relation\b/.test(l));
        add('Prisma models and relations', `${file} :: ${m[1]}: ${relations.map(l => l.trim()).join('; ') || '(no relations)'}`);
      }
    }
    if (/(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\./.test(file)) {
      const names = [...text.matchAll(/^([ \t]*)(?:describe|it|test)(?:\.(?:only|skip|todo))?\s*\(\s*['"`]([^'"`\r\n]+)['"`]/gm)];
      const indent = Math.min(...names.map(m => m[1].length));
      add('Tests (top-level names)', `${file}: ${names.filter(m => m[1].length === indent).map(m => m[2]).join('; ') || '(no literal names detected)'}`);
    }
  }
  for (const [dir, count] of counts) add('Top-level directories (file counts)', `${dir}: ${count}`);
  return ['# Repository map', '', 'Preparation snapshot; may be stale after edits. Pick candidate files here, then confirm with rg.',
    ...(limited ? ['Scan bounded; some files omitted.'] : []),
    ...Object.entries(sections).flatMap(([title, rows]) => ['', `## ${title}`, ...(rows.length ? rows : ['- (none detected)'])]), ''].join('\n');
}

export function ensureRepoMap({ checkoutRoot, matchRoot, recon }) {
  try {
    const root = path.resolve(checkoutRoot);
    const relative = path.relative(root, fs.realpathSync(matchRoot));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('assigned folder must be inside checkoutRoot');
    const dir = path.join(root, '.mtm-notes');
    if (!ensureExcluded(root, '/.mtm-notes/')) throw new Error('cannot ignore local notes');
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('notes directory is a symlink');
    const repoMapPath = path.join(dir, 'repo-map.md');
    // Repeated recon calls read the preparation snapshot, including after a helper restart.
    if (!fs.existsSync(repoMapPath)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(repoMapPath, buildRepoMap(matchRoot, recon), { encoding: 'utf8', flag: 'wx' });
    }
    return { repoMapPath };
  } catch (e) {
    return { repoMapPath: null, repoMapWarning: `Repository map unavailable: ${e.message}` };
  }
}
