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

/**
 * One file with everything an answer-only item needs, in reading order: item text, answer template, every KB
 * article fetched, test data and every production log line (UTC, oldest first, one per line). In EFMN62ZO the
 * PI-01 worker spent 4 tool turns (~20 s) opening brief.json, the raw MCP JSON (truncated at 19,678 tokens) and a
 * python dump before it could reason.
 */
export function answerDigest({ item, material }) {
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
    if (l.truncated?.length) out.push(`Not complete for: ${l.truncated.map((t) => `${t.service} (${t.fetched}/${t.total}${t.levelsOverLimit?.length ? `, over limit: ${t.levelsOverLimit.join('/')}` : ''})`).join('; ')}. Ask NEED_INFO with a narrowing word only if the answer depends on them.`, '');
    out.push('Format: timestamp-UTC | level | service | requestId | message | other fields', '', '```text');
    for (const e of l.entries || []) {
      const { timestamp, time, ts, level, service, requestId, message, ...rest } = e || {};
      const raw = timestamp ?? time ?? ts;
      const shown = utc(raw) + (raw && !/Z$/.test(String(raw)) ? ` (logged ${raw})` : '');
      out.push([shown, level ?? '', service ?? '', requestId ?? '', oneLine(message ?? ''), Object.keys(rest).length ? oneLine(rest) : ''].join(' | '));
    }
    out.push('```', '');
  }
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
    try { brief.digestPath = writeInside(matchRoot, `${relative}/digest.md`, answerDigest({ item, material }) + '\n'); } catch { /* the raw files stay */ }
  }
  const briefFile = writeInside(matchRoot, `${relative}/brief.json`, JSON.stringify(brief, null, 2) + '\n');
  fs.mkdirSync(filesDir, { recursive: true });
  return { briefFile, filesDir, files, repoMapPath, baselinePath, digestPath: brief.digestPath ?? null };
}
