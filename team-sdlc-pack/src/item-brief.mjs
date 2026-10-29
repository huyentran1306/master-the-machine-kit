import fs from 'node:fs';
import path from 'node:path';
import { ensureExcluded } from './git.mjs';

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
export function writeItemBrief({ checkoutRoot, worktreeRoot = checkoutRoot, matchRoot, item, material, commands = {} }) {
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
  const brief = {
    item: { id: item.id, type: item.type, title: item.title ?? null, description: item.description ?? '', acceptanceCriteria: item.acceptanceCriteria ?? null },
    startInstruction: material.startInstruction ?? '',
    minimumVerificationScenarios: material.minimumVerificationScenarios ?? null,
    submitTemplate: material.submitTemplate ?? null,
    commands, files,
  };
  const briefFile = writeInside(matchRoot, `${relative}/brief.json`, JSON.stringify(brief, null, 2) + '\n');
  fs.mkdirSync(filesDir, { recursive: true });
  return { briefFile, filesDir, files };
}
