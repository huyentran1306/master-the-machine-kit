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
  const briefFile = writeInside(matchRoot, `${relative}/brief.json`, JSON.stringify(brief, null, 2) + '\n');
  fs.mkdirSync(filesDir, { recursive: true });
  return { briefFile, filesDir, files, repoMapPath, baselinePath };
}
