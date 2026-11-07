// Code index built once per match, right after the fresh clone (recon_repo), and reused by every item.
// UDLWEWFR rollouts: 75% of code-worker tool output (1.7M of 2.3M chars) was rg/cat exploration of a
// 6,000-file monorepo before the first edit. The index ranks files for each item from the item's own
// words (no scenario keywords): defined symbols, path words, identifiers used, and import links to tests.
import fs from 'node:fs';
import path from 'node:path';
import { ensureExcluded } from './git.mjs';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target', 'bin', 'obj', 'venv', '__pycache__', 'answers', 'challenge', 'vendor']);
const SRC = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb|prisma|sql|vue|svelte|graphql)$/;
const TEST = /(?:^|\/)(?:__tests__|tests?|e2e|spec)\/|\.(?:test|spec)\.[^/]+$/;
const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const STOP = new Set('this that with from have will when then than they them their there were what which while where into only also must should could would each every other some such more most very just your the and for are but not all any can had her was one our out use used uses using item items task tasks answer answers given gets make made does done need needs value values field fields show shows shown page pages user users test tests file files code data true false null none return const function import export default class type interface async await string number boolean object array undefined void new let var else case break continue'.split(' '));
const words = id => String(id).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
const toks = text => String(text).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];

function defsOf(text) {
  const out = new Set();
  const add = re => { for (const m of text.matchAll(re)) { const n = m.slice(1).find(Boolean); if (n && out.size < 80) out.add(n); } };
  add(/^[ \t]{0,4}(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm);
  add(/^[ \t]{0,2}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/gm);
  add(/^[ \t]*(?:async\s+)?def\s+(\w+)|^[ \t]*class\s+(\w+)|^func\s+(?:\([^)]*\)\s*)?(\w+)|^\s*model\s+(\w+)\s*\{/gm);
  add(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(\w+)/gi);
  add(/^[ \t]*(?:handlers|app|router)\s*\[\s*['"]([\w/-]+)['"]\s*\]\s*=/gm);
  return [...out];
}
const specsOf = text => [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1] || m[2] || m[3] || m[4]);

/** Walk, parse and link the repository. Bounded: 8,000 files, 256 KB each, ~10 s. */
export function buildCodeIndex(matchRoot, { maxFiles = 8000, budgetMs = 10000 } = {}) {
  const started = Date.now(); const all = []; let limited = false;
  (function walk(dir, rel, depth) {
    if (depth > 20 || all.length >= maxFiles || Date.now() - started > budgetMs) { limited = true; return; }
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), name, depth + 1);
      else if (e.isFile() && (SRC.test(e.name) || e.name === 'package.json')) all.push(name);
      if (all.length >= maxFiles) { limited = true; return; }
    }
  })(matchRoot, '', 0);
  // Monorepo links: package names plus package.json "exports" ("./x/*") and "imports" ("#x/*") maps.
  const pkgDirs = []; const rules = [];
  const target = v => typeof v === 'string' ? v : v && typeof v === 'object' ? target(v.default ?? v.import ?? v.types ?? v.require ?? Object.values(v)[0]) : null;
  for (const f of all.filter(f => f.endsWith('package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(matchRoot, f), 'utf8')); const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
      if (pkg.name) pkgDirs.push([pkg.name, dir]);
      const map = (obj, toSpec, scope) => { if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) { const to = target(v); if (to && (k.startsWith('./') || k.startsWith('#'))) rules.push({ from: toSpec(k), to: path.posix.join(dir, to), scope }); } };
      if (pkg.name) map(pkg.exports, k => k === '.' ? pkg.name : `${pkg.name}${k.slice(1)}`, null);
      map(pkg.imports, k => k, dir);
    } catch { /* malformed package.json */ }
  }
  pkgDirs.sort((a, b) => b[0].length - a[0].length);
  const viaRules = (spec, from) => {
    const out = [];
    for (const r of rules) {
      if (r.scope != null && r.scope && !from.startsWith(`${r.scope}/`)) continue;
      const star = r.from.indexOf('*');
      if (star < 0) { if (spec === r.from) out.push(r.to); continue; }
      const pre = r.from.slice(0, star); const post = r.from.slice(star + 1);
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) out.push(r.to.replace('*', spec.slice(pre.length, spec.length - post.length)));
    }
    return out;
  };
  const srcs = all.filter(f => SRC.test(f)); const index = new Map(srcs.map((f, i) => [f, i]));
  const files = []; const postings = new Map(); const specs = [];
  for (const p of srcs) {
    let text = '';
    try { const full = path.join(matchRoot, p); if (fs.statSync(full).size <= 256 * 1024 && Date.now() - started < budgetMs) text = fs.readFileSync(full, 'utf8'); else limited = true; } catch { /* unreadable */ }
    const i = files.length; const f = { p, d: defsOf(text), i: [], k: 0 }; files.push(f); specs.push(specsOf(text));
    const seen = new Set(); const all = new Set();
    // Generated or minified bundles (long lines) match every word; keep their path words only.
    const lines = text.split('\n'); if (/\.min\.|\bgenerated\b/i.test(p) || text.length / Math.max(1, lines.length) > 250 || /^\/\/# sourceMappingURL=|^\s*\/\/#region .*node_modules\//m.test(text.slice(0, 4000))) text = '';
    for (const t of [...toks(text), ...p.split(/[/.]/)]) {
      all.add(t);
      const low = t.toLowerCase();
      for (const w of low.length >= 4 && !STOP.has(low) ? [low, ...words(t)] : words(t)) {
        if (seen.size >= 1500) break;
        if (!seen.has(w)) { seen.add(w); if (!postings.has(w)) postings.set(w, []); postings.get(w).push(i); }
      }
    }
    f.k = all.size;
  }
  const resolve = (spec, from) => {
    let bases = viaRules(spec, from);
    if (bases.length) { /* package map wins */ }
    else if (spec.startsWith('.')) bases = [path.posix.join(path.posix.dirname(from), spec)];
    else if (/^[@~]\//.test(spec)) bases = ['src', '', ...pkgDirs.map(([, d]) => d && `${d}/src`)].filter(b => b != null).map(b => path.posix.join(b, spec.slice(2)));
    else { const hit = pkgDirs.find(([n]) => spec === n || spec.startsWith(`${n}/`)); if (hit) { const rest = spec.slice(hit[0].length + 1); bases = rest ? [path.posix.join(hit[1], rest), path.posix.join(hit[1], 'src', rest)] : [path.posix.join(hit[1], 'src/index'), path.posix.join(hit[1], 'index')]; } }
    for (const b of bases) for (const base of [b, b.replace(/\.[cm]?js$/, '')]) for (const ext of EXT) { const j = index.get(base + ext); if (j != null) return j; }
    return null;
  };
  files.forEach((f, i) => { f.i = [...new Set(specs[i].map(s => resolve(s, f.p)).filter(j => j != null && j !== i))]; });
  const cap = Math.max(60, Math.floor(files.length * 0.3)); const t = {};
  for (const [w, list] of postings) if (list.length <= cap) t[w] = list;
  return { version: 1, builtAt: new Date().toISOString(), ms: Date.now() - started, limited, n: files.length, files, t };
}

// A failed build is not retried in the same helper process: writeItemBrief runs on every mtm-query result
// and must never spend the 10 s budget again for an index that cannot be written.
const failedRoots = new Map();
export function ensureCodeIndex({ checkoutRoot, matchRoot }) {
  const key = path.resolve(checkoutRoot || '.');
  if (failedRoots.has(key)) return { codeIndexPath: null, codeIndexWarning: failedRoots.get(key) };
  try {
    const dir = path.join(path.resolve(checkoutRoot), '.mtm-notes');
    const file = path.join(dir, 'code-index.json');
    if (!fs.existsSync(file)) {
      if (!ensureExcluded(checkoutRoot, '/.mtm-notes/')) throw new Error('cannot ignore local notes');
      fs.mkdirSync(dir, { recursive: true });
      const idx = buildCodeIndex(matchRoot);
      fs.writeFileSync(file, JSON.stringify(idx));
      return { codeIndexPath: file, files: idx.n, ms: idx.ms, limited: idx.limited };
    }
    return { codeIndexPath: file };
  } catch (e) { const warning = `Code index unavailable: ${e.message}`; failedRoots.set(key, warning); return { codeIndexPath: null, codeIndexWarning: warning }; }
}

const cache = new Map();
export function loadCodeIndex(checkoutRoot) {
  const file = path.join(path.resolve(checkoutRoot || '.'), '.mtm-notes', 'code-index.json');
  try {
    const m = fs.statSync(file).mtimeMs; const hit = cache.get(file);
    if (hit?.m === m) return hit.idx;
    const idx = JSON.parse(fs.readFileSync(file, 'utf8')); cache.set(file, { m, idx }); return idx;
  } catch { return null; }
}

/** Terms from the item text only: code-like identifiers, plain words and joined word pairs ("upcoming length" -> upcominglength). */
export function itemTerms(text) {
  const clean = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const terms = new Map(); const add = (w, weight) => { if (w.length >= 4 && !STOP.has(w)) terms.set(w, Math.max(terms.get(w) || 0, weight)); };
  for (const m of clean.matchAll(/`([^`\n]{2,80})`/g)) for (const t of toks(m[1])) { add(t.toLowerCase(), 3); words(t).forEach(w => add(w, 1.5)); }
  for (const t of toks(clean)) {
    const codeLike = /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]/.test(t);
    add(t.toLowerCase(), codeLike ? 2.5 : 1); if (codeLike) words(t).forEach(w => add(w, 1));
  }
  const seq = clean.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i + 1 < seq.length; i += 1) {
    if (STOP.has(seq[i]) || STOP.has(seq[i + 1])) continue;
    add(seq[i] + seq[i + 1], 2); if (i + 2 < seq.length && !STOP.has(seq[i + 2])) add(seq[i] + seq[i + 1] + seq[i + 2], 2.5);
  }
  return terms;
}

/**
 * Rank files for one item. `title` terms count double. `corpus` holds the other backlog items' texts:
 * a word used by half of them is submission boilerplate ("submit", "evidence", "schema"), not the problem.
 * Rare terms dominate (idf squared) and files are length-normalised, so a 3,000-line file matching
 * many common words does not outrank the 200-line file that defines the item's subject.
 */
export function likelyFiles(idx, text, { limit = 12, title = '', corpus = [] } = {}) {
  if (!idx?.files?.length) return { files: [], tests: [], terms: [] };
  const N = idx.n; const score = new Float64Array(N); const why = new Map(); const used = new Map();
  const others = corpus.filter(Boolean).map(c => new Set(itemTerms(c).keys()));
  const boiler = t => others.length >= 3 && others.filter(s => s.has(t)).length >= others.length * 0.4;
  const titleTerms = itemTerms(title);
  const all = itemTerms(`${title}\n${text}`);
  const explicit = [...String(text).matchAll(/((?:[\w.@-]+\/)+[\w.-]+\.\w{1,5})\b/g)].map(m => m[1]);
  for (const e of explicit) idx.files.forEach((f, i) => { if (f.p.endsWith(e) || e.endsWith(f.p)) { score[i] += 50; (why.get(i) || why.set(i, new Set()).get(i)).add(e); } });
  for (const [term, w0] of all) {
    const list = idx.t[term]; if (!list?.length || boiler(term)) continue;
    const w = titleTerms.has(term) ? w0 * 2 : w0;
    const idf = Math.log(1 + N / list.length); used.set(term, w * idf);
    for (const i of list) {
      const f = idx.files[i]; let s = w * idf * idf / Math.max(1, Math.sqrt((f.k || 400) / 400));
      if (f.d.some(d => d.toLowerCase() === term || d.toLowerCase().replace(/_/g, '') === term)) s *= 3;
      if (f.p.toLowerCase().includes(term)) s *= 2;
      score[i] += s; (why.get(i) || why.set(i, new Set()).get(i)).add(term);
    }
  }
  const importedBy = new Map(); idx.files.forEach((f, i) => f.i.forEach(j => (importedBy.get(j) || importedBy.set(j, []).get(j)).push(i)));
  const order = [...score.keys()].filter(i => score[i] > 0).sort((a, b) => score[b] - score[a]);
  const top = order.length ? score[order[0]] : 0;
  const keep = order.filter(i => score[i] >= top * 0.2);
  const isTest = i => TEST.test(idx.files[i].p);
  const terms = new Set([...why.values()].flatMap(s => [...s]));
  const files = keep.filter(i => !isTest(i)).slice(0, limit).map(i => {
    const f = idx.files[i]; const by = importedBy.get(i) || [];
    return { path: f.p, score: Math.round(score[i] * 10) / 10, matched: [...(why.get(i) || [])].slice(0, 6),
      defs: f.d.filter(d => terms.has(d.toLowerCase())).slice(0, 6).concat(f.d.filter(d => !terms.has(d.toLowerCase())).slice(0, 2)),
      tests: by.filter(isTest).map(j => idx.files[j].p).slice(0, 3), importedBy: by.length, imports: f.i.slice(0, 4).map(j => idx.files[j].p) };
  });
  const tests = [...new Set([...keep.filter(isTest).map(i => idx.files[i].p), ...files.flatMap(f => f.tests)])].slice(0, 8);
  return { files, tests, terms: [...used.keys()].sort((a, b) => used.get(b) - used.get(a)).slice(0, 12) };
}

export function renderLikelyFiles(result, root) {
  if (!result.files.length && !result.tests.length) return '';
  const out = ['# Likely files for this item', '', `Ranked from the item's own words against a code index built after the fresh clone. Paths are relative to ${root}. Start here, confirm with \`rg -n -m 20 <term> <these paths>\`, and search repo-wide only if none fits.`, '', `Item terms found in code: ${result.terms.join(', ') || '(none)'}`, ''];
  result.files.forEach((f, n) => {
    out.push(`${n + 1}. ${f.path}  (matched: ${f.matched.join(', ')})`);
    if (f.defs.length) out.push(`   defines: ${f.defs.join(', ')}`);
    if (f.imports.length) out.push(`   imports: ${f.imports.join(', ')}`);
    if (f.tests.length || f.importedBy) out.push(`   used by ${f.importedBy} file(s)${f.tests.length ? `; tests: ${f.tests.join(', ')}` : ''}`);
  });
  if (result.tests.length) out.push('', '## Related tests', ...result.tests.map(t => `- ${t}`));
  return out.join('\n') + '\n';
}
