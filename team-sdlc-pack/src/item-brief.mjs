import fs from 'node:fs';
import path from 'node:path';
import { ensureExcluded } from './git.mjs';
import { extractRequiredEvidence } from './required-evidence.mjs';

// Start Work files are data. Reject path traversal on both Windows and POSIX, even when
// a pack is tested on a different OS from the eventual contest machine.
function partsOf(relative) {
  const parts = String(relative).replace(/\\/g, '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) {
    throw new Error(`Unsafe brief path: ${relative}`);
  }
  return parts;
}

function writeInside(root, relative, text) {
  const parts = partsOf(relative);
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`Brief path must not be a link: ${relative}`);
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return target;
}

const oneLine = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
const textOf = (result) => (result?.raw?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
const utc = (ts) => { const t = Date.parse(ts ?? ''); return Number.isNaN(t) ? String(ts ?? '?') : new Date(t).toISOString().replace('.000Z', 'Z'); };

/** Answer-only questions that explicitly require repository truth must not use the digest-only fast path. */
export function answerNeedsSource(item = {}) {
  const text = `${item.title || ''}\n${item.description || ''}`;
  return /application source|source code|from the (?:issued )?(?:app|code)|in the code|\b(?:src|app|server|lib|components?)\/[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rb)\b/i.test(text);
}

function sourceTerms(item) {
  const stop = new Set('the a an and or to from in of for with by is are be this that answer issued application source code read trace after before one two'.split(' '));
  return [...new Set(`${item.title || ''} ${item.description || ''}`.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [])]
    .filter(w => !stop.has(w)).slice(0, 24);
}

function sourceDigest(root, item, cap = 12000) {
  if (!root || !fs.existsSync(root)) return '';
  const terms = sourceTerms(item); const candidates = []; const todo = [root]; let scanned = 0;
  while (todo.length && scanned < 500) {
    const dir = todo.pop();
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'answers', 'challenge'].includes(ent.name)) continue;
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) { todo.push(file); continue; }
      if (!/\.(?:[cm]?[jt]sx?|py|go|rb)$/.test(ent.name) || ++scanned > 500) continue;
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (text.length > 250000) continue;
      const low = `${path.relative(root, file)}\n${text}`.toLowerCase();
      const score = terms.reduce((n, term) => n + (low.includes(term) ? 1 : 0), 0);
      if (score) candidates.push({ file, score, text });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  let out = '';
  for (const c of candidates.slice(0, 8)) {
    const rel = path.relative(root, c.file).replace(/\\/g, '/');
    const room = cap - out.length; if (room < 200) break;
    out += `\n### ${rel}\n\n\`\`\`\n${c.text.slice(0, Math.max(0, room - rel.length - 20))}\n\`\`\`\n`;
  }
  return out.slice(0, cap);
}

/**
 * One file with everything an answer-only item needs, in reading order: item text, answer template, every KB
 * article fetched, test data and every production log line (UTC, oldest first, one per line). In EFMN62ZO the
 * PI-01 worker spent 4 tool turns (~20 s) opening brief.json, the raw MCP JSON (truncated at 19,678 tokens) and a
 * python dump before it could reason.
 */
export function answerDigest({ item, material, source = '' }) {
  const out = [`# ${item.id} digest: everything needed for the answer`, '', '## Item', '', String(item.description || item.title || '').trim(), ''];
  if (material.startInstruction) out.push(`Start instruction: ${oneLine(material.startInstruction)}`, '');
  if (material.submitTemplate) out.push('## Answer template (keep every key; set status DONE)', '', '```json', JSON.stringify(material.submitTemplate, null, 2), '```', '');
  const seenKb = new Set();
  const kb = [];
  const logs = [];
  const other = [];
  for (const entry of material.mcpMaterial || []) {
    if (!entry || entry.ok === false || entry.purpose === 'discovery') continue;
    if (String(entry.tool || '').endsWith('-merged')) { logs.push(entry.result); continue; }
    const text = textOf(entry.result);
    let data = null; try { data = JSON.parse(text); } catch { /* plain text */ }
    if (Array.isArray(data?.articles)) {
      for (const a of data.articles) if (a?.id && !seenKb.has(a.id)) { seenKb.add(a.id); kb.push(a); }
    } else if (entry.purpose === 'logs') {
      continue; // per-call log reads are covered by the merged sweep
    } else if (text) other.push({ tool: entry.tool, args: entry.args, text });
  }
  if (kb.length) {
    out.push('## Company knowledge base articles', '');
    for (const a of kb) out.push(`### ${a.id} ${a.title || ''}`.trim(), '', String(a.body || a.content || '').trim(), '');
  }
  for (const o of other) out.push(`## ${o.tool} ${oneLine(o.args || {})}`, '', o.text.length > 6000 ? `${o.text.slice(0, 6000)}\n…(truncated, full file in files/mcp/)` : o.text, '');
  for (const l of logs) {
    if (!l) continue;
    out.push(`## Production logs: ${l.unique} unique entries, UTC, oldest first`, '');
    if (l.truncated?.length) {
      const missing = l.truncated.filter(t => t.reason).map(t => t.service);
      if (missing.length) out.push(`MISSING: ${missing.join(', ')}. These services failed or timed out during collection.`, '');
      out.push(`Not complete for: ${l.truncated.map((t) => t.reason ? `${t.service} (${t.reason})` : `${t.service} (${t.fetched}/${t.total}${t.levelsOverLimit?.length ? `, over limit: ${t.levelsOverLimit.join('/')}` : ''})`).join('; ')}. Ask NEED_INFO with a narrowing word only if the answer depends on them.`, '');
    }
    out.push('Format: timestamp-UTC | level | service | requestId | message | other fields', '', '```text');
    for (const e of l.entries || []) {
      const { timestamp, time, ts, level, service, requestId, message, ...rest } = e || {};
      const raw = timestamp ?? time ?? ts;
      const shown = utc(raw) + (raw && !/Z$/.test(String(raw)) ? ` (logged ${raw})` : '');
      out.push([shown, level ?? '', service ?? '', requestId ?? '', oneLine(message ?? ''), Object.keys(rest).length ? oneLine(rest) : ''].join(' | '));
    }
    out.push('```', '');
  }
  if (source) out.push('## Issued application source', '', 'Answer from this source; read more files under src/ only if a needed function is missing here.', source, '');
  return out.join('\n');
}

/** Materialize a self-contained handoff within the child's permitted match folder. */
export function writeItemBrief({ checkoutRoot, worktreeRoot = checkoutRoot, matchRoot, item, material, commands = {}, context = {} }) {
  if (!material) throw new Error('Start Work material is missing; start the item before creating its worktree.');
  const folder = path.relative(worktreeRoot, matchRoot).replace(/\\/g, '/');
  partsOf(folder);
  const idParts = partsOf(item.id);
  if (idParts.length !== 1) throw new Error('Item ID must be one path component');
  if (!ensureExcluded(checkoutRoot, `/${folder}/.mtm-briefs/`)) throw new Error('Cannot git-ignore the item brief');
  const relative = `.mtm-briefs/${item.id}`;
  const filesDir = path.join(matchRoot, relative, 'files');
  const files = {};
  // Validate every filename before writing any organizer files.
  for (const name of Object.keys(material.files || {})) partsOf(name);
  for (const [name, content] of Object.entries(material.files || {})) {
    files[name] = writeInside(matchRoot, `${relative}/files/${name}`,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const mcpMaterial = (material.mcpMaterial || []).map((entry, index) => {
    const label = String(entry.tool || entry.purpose || 'result').replace(/[^a-zA-Z0-9_-]/g, '-');
    let name = `mcp/${label}-${index + 1}.json`;
    let suffix = 0;
    while (Object.hasOwn(files, name)) name = `mcp/${label}-${index + 1}-${++suffix}.json`;
    const file = writeInside(matchRoot, `${relative}/files/${name}`, JSON.stringify(entry.result ?? entry, null, 2) + '\n');
    files[name] = file;
    return { purpose: entry.purpose, tool: entry.tool, args: entry.args, ok: entry.ok, error: entry.error, file };
  });
  const sourceMap = path.join(checkoutRoot, '.mtm-notes', 'repo-map.md');
  const repoMapPath = fs.existsSync(sourceMap)
    ? writeInside(matchRoot, `${relative}/repo-map.md`, fs.readFileSync(sourceMap, 'utf8')) : null;
  const sourceBaseline = path.join(checkoutRoot, '.mtm-notes', 'baseline.md');
  const baselinePath = fs.existsSync(sourceBaseline)
    ? writeInside(matchRoot, `${relative}/baseline.md`, fs.readFileSync(sourceBaseline, 'utf8')) : null;
  const brief = {
    item: { id: item.id, type: item.type, title: item.title ?? null, description: item.description ?? '', acceptanceCriteria: item.acceptanceCriteria ?? null },
    startInstruction: material.startInstruction ?? '',
    minimumVerificationScenarios: material.minimumVerificationScenarios ?? null,
    submitTemplate: material.submitTemplate ?? null,
    requiredEvidence: material.requiredEvidence ?? extractRequiredEvidence(item, material), mcpMaterial,
    commands, files, repoMapPath, baselinePath, ...context,
  };
  if (context.answerOnly) {
    try {
      const source = context.answerSource ? sourceDigest(context.appPath || matchRoot, item) : '';
      brief.digestPath = writeInside(matchRoot, `${relative}/digest.md`, answerDigest({ item, material, source }) + '\n');
    } catch { /* the raw files stay */ }
  }
  const briefFile = writeInside(matchRoot, `${relative}/brief.json`, JSON.stringify(brief, null, 2) + '\n');
  fs.mkdirSync(filesDir, { recursive: true });
  return { briefFile, filesDir, files, repoMapPath, baselinePath, digestPath: brief.digestPath ?? null };
}
