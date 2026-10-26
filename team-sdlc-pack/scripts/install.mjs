#!/usr/bin/env node
// Installs the team pack into an absolute TeamWorkspace (technical guide section 5):
//   <TW>/team-sdlc-pack/runtime/   immutable payload (package.json + package.files)
//   <TW>/team-sdlc-pack/logs/      progress logs (never touched by reinstall)
//   <TW>/.mtm/                     team-runtime.json, team-pack-info.json
//   <TW>/.codex/agents/            profile copies
//   <TW>/.codex/config.toml        MCP registration with the absolute runtime path
//   <TW>/.agents/skills/           skill copies
//   <TW>/matches/                  created if missing; never modified
// Idempotent; upgrades replace only pack-owned files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJsonStrict, validateIdentity, validateManifest, validatePackageJson, validateProfiles, expandRegistration, registrationLayout, payloadFiles, walk, isLinkOrJunction,
  sha256File, REQUIRED_SKILLS,
} from '../src/pack-contract.mjs';

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!-- mtm-team-sdlc-pack: workspace instructions (managed by install.mjs) -->';
const SETTINGS_MARK = '_mtmTeamPack';

function args(argv) {
  const out = { teamWorkspace: null, allowPlaceholder: false, dryRun: false, noCheck: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--team-workspace' || a === '-TeamWorkspace') out.teamWorkspace = argv[++i];
    else if (a.startsWith('--team-workspace=')) out.teamWorkspace = a.split('=').slice(1).join('=');
    else if (a === '--allow-placeholder') out.allowPlaceholder = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-check') out.noCheck = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function fail(msg) {
  console.error(`TEAM_PACK_INSTALL_FAILED: ${msg}`);
  process.exit(1);
}

function copyFile(src, dst, dry) {
  if (dry) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function rmrf(p, dry) {
  if (!dry && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

export async function install(opts) {
  const tw = opts.teamWorkspace;
  if (!tw || !path.isAbsolute(tw)) throw new Error('--team-workspace must be an absolute path');
  const TW = path.resolve(tw);
  for (const p of [TW, path.join(TW, 'team-sdlc-pack'), path.join(TW, '.codex'), path.join(TW, '.agents'), path.join(TW, '.claude'), path.join(TW, '.mtm'), path.join(TW, 'matches')]) {
    if (isLinkOrJunction(p)) throw new Error(`unsafe target (symlink/junction): ${p}`);
  }
  if (fs.existsSync(TW) && !fs.statSync(TW).isDirectory()) throw new Error(`${TW} is not a directory`);
  if (path.resolve(PACK).startsWith(path.join(TW, 'team-sdlc-pack', 'runtime'))) throw new Error('run the installer from the source package, not from the installed runtime');

  // 1. Verify the source package.
  const pkg = readJsonStrict(path.join(PACK, 'package.json'));
  const info = readJsonStrict(path.join(PACK, 'team-pack-info.json'));
  const manifest = readJsonStrict(path.join(PACK, 'team-runtime.json'));
  const errors = [
    ...validatePackageJson(pkg),
    ...validateIdentity(info, { allowPlaceholder: opts.allowPlaceholder }),
    ...validateManifest(manifest, pkg.version),
  ];
  if (info.version !== pkg.version) errors.push(`team-pack-info.version ${info.version} != package.json ${pkg.version}`);
  errors.push(...validateProfiles(path.join(PACK, 'agents')).errors);
  for (const s of REQUIRED_SKILLS) if (!fs.existsSync(path.join(PACK, 'skills', s, 'SKILL.md'))) errors.push(`missing skills/${s}/SKILL.md`);
  let files;
  try {
    files = payloadFiles(PACK, pkg);
  } catch (e) {
    errors.push(e.message);
  }
  const sums = path.join(PACK, 'CHECKSUMS.sha256');
  if (fs.existsSync(sums)) {
    for (const line of fs.readFileSync(sums, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const [hash, rel] = line.split(/\s+\*?/);
      const f = path.join(PACK, rel);
      if (!fs.existsSync(f)) errors.push(`checksum: missing ${rel}`);
      else if (sha256File(f) !== hash) errors.push(`checksum mismatch: ${rel}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n  - '));

  // 2. Layout.
  const provider = manifest.provider;
  const lay = registrationLayout(provider);
  const runtime = path.join(TW, 'team-sdlc-pack', 'runtime');
  if (!opts.dryRun) {
    for (const d of [path.join(TW, 'matches'), path.join(TW, 'team-sdlc-pack', 'logs'), path.join(TW, '.mtm'), path.join(TW, lay.agentsDir), path.join(TW, lay.skillsDir), ...(lay.extraSkillsDirs || []).map((x) => path.join(TW, x))]) fs.mkdirSync(d, { recursive: true });
  }

  // 3. Payload (runtime is fully pack-owned: replace it).
  rmrf(runtime, opts.dryRun);
  for (const rel of files) copyFile(path.join(PACK, rel), path.join(runtime, rel), opts.dryRun);

  // 4. Registration copies. Remove what the previous install owned, then copy.
  const ownFile = path.join(TW, 'team-sdlc-pack', 'install-manifest.json');
  const previous = fs.existsSync(ownFile) ? readJsonStrict(ownFile) : { registration: [], skills: [] };
  for (const rel of previous.registration || []) {
    const p = path.join(TW, rel);
    if (rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel.endsWith('settings.json')) continue; // handled below with ownership markers
    if (!opts.dryRun && fs.existsSync(p) && !isLinkOrJunction(p)) fs.rmSync(p, { force: true });
  }
  const registration = [];
  for (const f of fs.readdirSync(path.join(PACK, 'agents')).filter((x) => x.endsWith(lay.agentExt))) {
    copyFile(path.join(PACK, 'agents', f), path.join(TW, lay.agentsDir, f), opts.dryRun);
    registration.push(`${lay.agentsDir}/${f}`);
  }
  const skills = fs.readdirSync(path.join(PACK, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const skillDirs = [lay.skillsDir, ...(lay.extraSkillsDirs || [])];
  for (const dir of skillDirs) {
    if (!opts.dryRun) fs.mkdirSync(path.join(TW, dir), { recursive: true });
    for (const skill of skills) {
      const dst = path.join(TW, dir, skill);
      if (fs.existsSync(dst) && !(previous.skills || []).includes(skill)) {
        // A folder we did not create: keep a backup instead of overwriting it.
        if (!opts.dryRun) fs.renameSync(dst, `${dst}.bak-before-team-pack-${Date.now()}`);
      } else rmrf(dst, opts.dryRun);
      for (const f of walk(path.join(PACK, 'skills', skill))) copyFile(path.join(PACK, 'skills', skill, f), path.join(dst, f), opts.dryRun);
    }
  }
  for (const dir of [...new Set([...(previous.skillDirs || [previous.skillsDir].filter(Boolean)), ...skillDirs])]) {
    for (const stale of (previous.skills || []).filter((x) => !skills.includes(x))) rmrf(path.join(TW, dir, stale), opts.dryRun);
  }
  for (const f of ['team-runtime.json', 'team-pack-info.json']) {
    copyFile(path.join(PACK, f), path.join(TW, '.mtm', f), opts.dryRun);
    registration.push(`.mtm/${f}`);
  }
  const config = expandRegistration(provider, fs.readFileSync(path.join(PACK, lay.mcpSource), 'utf8'), TW);
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(path.join(TW, lay.mcpFile)), { recursive: true });
    fs.writeFileSync(path.join(TW, lay.mcpFile), config);
  }
  registration.push(lay.mcpFile);
  if (lay.settings && fs.existsSync(path.join(PACK, lay.settingsSource))) {
    const dst = path.join(TW, lay.settings);
    const cur = fs.existsSync(dst) ? readJsonStrict(dst) : null;
    if (!cur || cur[SETTINGS_MARK]) {
      const val = { ...readJsonStrict(path.join(PACK, lay.settingsSource)), [SETTINGS_MARK]: pkg.version };
      if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, `${JSON.stringify(val, null, 2)}\n`);
      }
      registration.push(lay.settings);
    }
  }

  // 5. Workspace instructions (AGENTS.md / CLAUDE.md) only if absent or ours.
  const instr = path.join(TW, lay.instructions);
  const src = path.join(PACK, lay.instructionsSource);
  let agentsNote = 'skipped';
  if (fs.existsSync(src)) {
    const cur = fs.existsSync(instr) ? fs.readFileSync(instr, 'utf8') : null;
    if (cur == null || cur.startsWith(MARKER)) {
      if (!opts.dryRun) fs.writeFileSync(instr, `${MARKER}\n${fs.readFileSync(src, 'utf8')}`);
      registration.push(lay.instructions);
      agentsNote = 'written';
    } else agentsNote = 'kept (not created by the pack)';
  }

  if (!opts.dryRun) {
    fs.writeFileSync(ownFile, `${JSON.stringify({ version: pkg.version, provider, teamId: info.teamId, installedFrom: PACK, registration, skills, skillsDir: lay.skillsDir, skillDirs }, null, 2)}\n`);
  }
  return { TW, provider, version: pkg.version, teamId: info.teamId, teamName: info.teamName, payload: files.length, registration, agentsNote, config };
}

async function main() {
  let o;
  try {
    o = args(process.argv);
  } catch (e) {
    fail(e.message);
  }
  if (o.help) {
    console.log('node scripts/install.mjs --team-workspace <absolute path> [--allow-placeholder] [--dry-run] [--no-check]');
    return;
  }
  let r;
  try {
    r = await install(o);
  } catch (e) {
    fail(`\n  - ${e.message}`);
  }
  console.log(`${o.dryRun ? 'DRY RUN ' : ''}installed team-sdlc-pack ${r.version} for ${r.teamId} (${r.teamName}) into ${r.TW}`);
  console.log(`  provider ${r.provider}; payload files: ${r.payload}; registration: ${r.registration.length}; workspace instructions ${r.agentsNote}`);
  if (o.dryRun || o.noCheck) return;
  const { check } = await import('./check-distribution.mjs');
  const res = await check({ teamWorkspace: r.TW, allowPlaceholder: o.allowPlaceholder, source: PACK });
  for (const l of res.lines) console.log(l);
  console.log(res.ready ? 'READY' : 'NOT_READY');
  if (!res.ready) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
