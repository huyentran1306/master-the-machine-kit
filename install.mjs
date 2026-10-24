#!/usr/bin/env node
// Installs the Digital Project Team into Codex (global, so the customer repo stays untouched):
//   <CODEX_HOME>/AGENTS.md              MTM block between markers (other content kept, backup made once)
//   <CODEX_HOME>/skills/mtm-*/          playbooks, each with an ownership marker
//   <CODEX_HOME>/hooks.json             keep-alive (Stop), guard (PreToolUse), resume (SessionStart); other hooks kept
//   <CODEX_HOME>/mtm-kit/<version>/     stable runtime copy; the extracted kit may be moved afterwards
// node install.mjs [--codex-home DIR] [--dry-run] [--uninstall] [--no-hooks]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version;
const OWNER_FILE = '.mtm-kit-owned.json';
const OWNER_ID = 'master-the-machine-dpt-kit';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`--${n} needs a directory`); process.exit(1); }
  return v;
};
const known = ['codex-home', 'dry-run', 'uninstall', 'no-hooks'];
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.includes(a.replace(/^--/, '').split('=')[0]) && argv[i - 1] !== '--codex-home');
if (unknown.length) { console.error(`unknown option: ${unknown.join(' ')} (use --codex-home DIR, --dry-run, --uninstall, --no-hooks)`); process.exit(1); }

const home = path.resolve(value('codex-home') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const dry = flag('dry-run');
const BEGIN = '<!-- MTM:BEGIN (managed by dpt-kit/install.mjs) -->';
const END = '<!-- MTM:END -->';
const slash = (p) => p.replace(/\\/g, '/');
const runtimeRoot = path.join(home, 'mtm-kit', VERSION);
const vars = { MTM: `node "${slash(path.join(runtimeRoot, 'tool', 'mtm.mjs'))}"`, KIT: slash(runtimeRoot), SKILLS: slash(path.join(home, 'skills')) };
const fill = (s) => s.replace(/\{\{(MTM|KIT|SKILLS)\}\}/g, (_, k) => vars[k]);
const owner = (kind, name) => ({ owner: OWNER_ID, version: VERSION, kind, name });

function write(file, text) {
  console.log(`${dry ? '[dry-run] ' : ''}write ${file}`);
  if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
}

function ownership(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { return null; }
}

function isOwned(dir, kind) {
  const m = ownership(dir);
  return m?.owner === OWNER_ID && (!kind || m.kind === kind);
}

function backupCollision(dir) {
  if (!fs.existsSync(dir) || isOwned(dir)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = `${dir}.bak-before-mtm-${stamp}`;
  for (let n = 2; fs.existsSync(backup); n++) backup = `${dir}.bak-before-mtm-${stamp}-${n}`;
  console.log(`${dry ? '[dry-run] ' : ''}WARNING: preserve unowned directory ${dir} as ${backup}`);
  if (!dry) fs.renameSync(dir, backup);
}

function installRuntime() {
  console.log(`${dry ? '[dry-run] ' : ''}install runtime ${runtimeRoot}`);
  if (dry) return;
  backupCollision(runtimeRoot);
  const stage = `${runtimeRoot}.tmp-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    fs.cpSync(path.join(KIT, 'tool'), path.join(stage, 'tool'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'codex'), { recursive: true });
    fs.copyFileSync(path.join(KIT, 'codex', 'LAUNCH_PROMPT.md'), path.join(stage, 'codex', 'LAUNCH_PROMPT.md'));
    fs.writeFileSync(path.join(stage, OWNER_FILE), `${JSON.stringify(owner('runtime', VERSION), null, 2)}\n`);
    if (fs.existsSync(runtimeRoot)) fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.renameSync(stage, runtimeRoot);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

function installSkill(name) {
  const dir = path.join(home, 'skills', name);
  backupCollision(dir);
  if (!dry && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  write(path.join(dir, 'SKILL.md'), fill(fs.readFileSync(path.join(KIT, 'skills', name, 'SKILL.md'), 'utf8')));
  write(path.join(dir, OWNER_FILE), `${JSON.stringify(owner('skill', name), null, 2)}\n`);
}

function removeOwned(dir, kind) {
  if (!fs.existsSync(dir)) return;
  if (!isOwned(dir, kind)) {
    console.log(`WARNING: leave ${dir}: it has no ${OWNER_ID} ownership marker`);
    return;
  }
  console.log(`${dry ? '[dry-run] ' : ''}remove ${dir}`);
  if (!dry) fs.rmSync(dir, { recursive: true, force: true });
}

function stripBlock(text) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return text;
  return (text.slice(0, a) + text.slice(b + END.length)).replace(/\n{3,}/g, '\n\n').trim();
}

const agentsFile = path.join(home, 'AGENTS.md');
const current = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : '';
const others = stripBlock(current);
const skillNames = fs.readdirSync(path.join(KIT, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

// Hooks: our handlers are recognised by their command (tool/hooks.mjs); everything else in hooks.json stays.
const hooksFile = path.join(home, 'hooks.json');
const HOOK_CMD = `node "${slash(path.join(runtimeRoot, 'tool', 'hooks.mjs'))}"`;
const isOurs = (h) => typeof h?.command === 'string'
  && /\/tool\/hooks\.mjs"?$/.test(h.command.replace(/\\/g, '/'))
  && String(h.statusMessage || '').startsWith('MTM ');
const OUR_HOOKS = {
  Stop: { hooks: [{ type: 'command', command: HOOK_CMD, commandWindows: HOOK_CMD, timeout: 15, statusMessage: 'MTM keep-alive' }] },
  PreToolUse: { matcher: '*', hooks: [{ type: 'command', command: HOOK_CMD, commandWindows: HOOK_CMD, timeout: 10, statusMessage: 'MTM guard' }] },
  SessionStart: { hooks: [{ type: 'command', command: HOOK_CMD, commandWindows: HOOK_CMD, timeout: 10, statusMessage: 'MTM resume' }] },
};

function updateHooks(add) {
  let cfg = {};
  if (fs.existsSync(hooksFile)) {
    try { cfg = JSON.parse(fs.readFileSync(hooksFile, 'utf8').replace(/^﻿/, '')); } catch {
      console.log(`WARNING: ${hooksFile} is not valid JSON: hooks not ${add ? 'installed' : 'removed'}. Fix the file and run the installer again.`);
      return false;
    }
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  for (const ev of new Set([...Object.keys(cfg.hooks), ...Object.keys(OUR_HOOKS)])) {
    const groups = (Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (add && OUR_HOOKS[ev]) groups.push(OUR_HOOKS[ev]);
    if (groups.length) cfg.hooks[ev] = groups; else delete cfg.hooks[ev];
  }
  const empty = !Object.keys(cfg.hooks).length && Object.keys(cfg).length === 1;
  if (empty && !add) {
    if (fs.existsSync(hooksFile)) { console.log(`${dry ? '[dry-run] ' : ''}remove ${hooksFile}`); if (!dry) fs.rmSync(hooksFile); }
  } else write(hooksFile, `${JSON.stringify(cfg, null, 2)}\n`);
  return true;
}

if (flag('uninstall')) {
  updateHooks(false);
  write(agentsFile, others ? `${others}\n` : '');
  for (const s of skillNames) removeOwned(path.join(home, 'skills', s), 'skill');
  removeOwned(runtimeRoot, 'runtime');
  console.log('MTM removed from Codex.');
  process.exit(0);
}

const override = path.join(home, 'AGENTS.override.md');
if (fs.existsSync(override)) {
  console.log(`WARNING: ${override} exists. Codex reads it instead of the global AGENTS.md, so the kit instructions are not loaded. Move it away before the match.`);
}
if (current.trim() && !current.includes(BEGIN)) {
  const backup = `${agentsFile}.bak-before-mtm`;
  if (!fs.existsSync(backup)) write(backup, current);
}
installRuntime();
const block = `${BEGIN}\n${fill(fs.readFileSync(path.join(KIT, 'codex', 'AGENTS.md'), 'utf8')).trim()}\n${END}`;
write(agentsFile, `${others ? `${others}\n\n` : ''}${block}\n`);
for (const s of skillNames) installSkill(s);
const hooked = flag('no-hooks') ? (updateHooks(false), false) : updateHooks(true);
console.log(`\nInstalled MTM-KIT ${VERSION} into ${home} (stable runtime + AGENTS.md + ${skillNames.length} skills${hooked ? ' + 3 hooks' : ', no hooks'}). MTM command for the agent: ${vars.MTM}`);
if (hooked) console.log('Hooks run only after Codex trusts them: open codex once, type /hooks, review and trust the 3 "MTM" hooks (again after every reinstall that changes them).');
console.log('Install into every Codex home that may run the match (Game Player, backup account): node install.mjs --codex-home <dir>.');
console.log('Next: set the Codex run settings for match day as the organizers\' Game Player guide says (see README, section "Cấu hình Codex").');
