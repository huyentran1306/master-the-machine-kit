// Packaging contract shared by scripts/install.mjs and scripts/check-distribution.mjs
// (technical guide section 5). Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_NAME = 'team-sdlc-pack';
export const REQUIRED_FILES_ORDER = [
  'agents/', 'bin/', 'config/', 'contracts/', 'docs/', 'install.ps1', 'scripts/check-distribution.mjs', 'scripts/install.mjs',
  'skills/', 'src/', 'README.md', 'team-pack-info.json', 'team-runtime.json',
];
// mtm-player 0.5.1 "currently requires" these four provider profiles (guide section 5).
export const REQUIRED_PROFILES = ['team_orchestrator', 'team_repo_scout', 'team_feature_worker', 'team_quality_checker'];
export const REQUIRED_SKILLS = ['team-orchestrator', 'game-preparation', 'team-recovery'];
export const REQUIRED_TOOLS = ['configure_session', 'login_match', 'refresh_match', 'start_work', 'submit_work', 'report_progress', 'wait_for_update'];
export const PLACEHOLDER_TEAM_IDS = ['YOUR_TEAM_ID', 'T01', 'HNKSUPER'];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function readJsonStrict(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function validateIdentity(info, { allowPlaceholder = false } = {}) {
  const errors = [];
  const keys = Object.keys(info || {});
  const expected = ['schemaVersion', 'version', 'teamId', 'teamName'];
  if (keys.length !== 4 || !expected.every((k) => keys.includes(k))) errors.push(`team-pack-info.json must have exactly ${expected.join(', ')} (has ${keys.join(', ')})`);
  if (info?.schemaVersion !== 1) errors.push('team-pack-info.schemaVersion must be 1');
  if (!VERSION_RE.test(info?.version || '')) errors.push('team-pack-info.version must be X.Y.Z');
  if (!TEAM_ID_RE.test(info?.teamId || '')) errors.push('teamId must be 1-128 chars: letter/digit then letters, digits, _ . : -');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(info?.teamId || '')) errors.push('teamId must be the registered team code, not a UUID');
  const name = info?.teamName;
  if (typeof name !== 'string' || !name.length || name.length > 160 || name !== name.trim() || /[\r\n\u0000]/.test(name)) errors.push('teamName must be 1-160 chars, no leading/trailing whitespace, newline or NUL');
  if (!allowPlaceholder && (PLACEHOLDER_TEAM_IDS.includes(info?.teamId) || /^your team name$/i.test(name || '') || name === 'Example Team')) {
    errors.push(`team identity is still a placeholder (${info?.teamId} / ${name}): set your registered teamId and teamName`);
  }
  return errors;
}

export function validateManifest(m, version) {
  const errors = [];
  const keys = Object.keys(m || {}).sort().join(',');
  if (keys !== ['entrypoint', 'kind', 'name', 'protocolVersion', 'provider', 'schemaVersion', 'version'].sort().join(',')) errors.push(`team-runtime.json must contain exactly schemaVersion, kind, name, version, protocolVersion, provider, entrypoint (has ${keys})`);
  if (m?.schemaVersion !== 1) errors.push('team-runtime.schemaVersion must be 1');
  if (m?.kind !== 'mtm-team-runtime') errors.push('team-runtime.kind must be mtm-team-runtime');
  if (m?.name !== PACKAGE_NAME) errors.push(`team-runtime.name must be ${PACKAGE_NAME}`);
  if (!Number.isInteger(m?.protocolVersion)) errors.push('team-runtime.protocolVersion must be an integer');
  if (typeof m?.provider !== 'string' || !m.provider) errors.push('team-runtime.provider is required');
  const ek = Object.keys(m?.entrypoint || {});
  if (ek.length !== 1 || m?.entrypoint?.rootAgentType !== 'team_orchestrator') errors.push('team-runtime.entrypoint must be exactly { rootAgentType: "team_orchestrator" }');
  if (version && m?.version !== version) errors.push(`team-runtime.version ${m?.version} != ${version}`);
  return errors;
}

export function validatePackageJson(pkg) {
  const errors = [];
  if (pkg?.name !== PACKAGE_NAME) errors.push(`package.json name must be ${PACKAGE_NAME}`);
  if (!VERSION_RE.test(pkg?.version || '')) errors.push('package.json version must be X.Y.Z');
  if (JSON.stringify(pkg?.files) !== JSON.stringify(REQUIRED_FILES_ORDER)) errors.push('package.json files must list exactly the guide entries in the guide order');
  if (pkg?.scripts && Object.keys(pkg.scripts).some((k) => /^(pre|post)?install$|^prepare$/.test(k))) errors.push('package.json must not define install lifecycle hooks');
  if (pkg?.dependencies && Object.keys(pkg.dependencies).length) errors.push('the minimal pack must not have npm dependencies');
  return errors;
}

/** name in TOML must equal the filename with hyphens -> underscores (team-orchestrator.toml -> team_orchestrator). */
export function readProfiles(agentsDir) {
  const out = [];
  if (!fs.existsSync(agentsDir)) return out;
  for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith('.toml')).sort()) {
    const text = fs.readFileSync(path.join(agentsDir, f), 'utf8');
    const m = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const d = text.match(/^\s*description\s*=\s*"([^"]*)"/m);
    out.push({ file: f, name: m ? m[1] : null, description: d ? d[1] : null, matchesFile: !!m && m[1].replace(/_/g, '-') === f.replace(/\.toml$/, '').replace(/_/g, '-') });
  }
  return out;
}

export function validateProfiles(agentsDir, required = REQUIRED_PROFILES) {
  const errors = [];
  const profiles = readProfiles(agentsDir);
  for (const p of profiles) {
    if (!p.name) errors.push(`${p.file}: missing name`);
    else if (!p.matchesFile) errors.push(`${p.file}: name "${p.name}" does not match the file name`);
    if (!p.description) errors.push(`${p.file}: missing description`);
  }
  const names = profiles.map((p) => p.name);
  for (const r of required) if (!names.includes(r)) errors.push(`missing agent profile ${r}`);
  return { errors, profiles };
}

/**
 * Expand config/codex.toml: relative entries of args = [...] become absolute paths from
 * <TeamWorkspace>/.codex, JSON-quoted with forward slashes. Nothing else changes.
 */
export function expandCodexConfig(text, teamWorkspace) {
  const base = path.join(teamWorkspace, '.codex');
  return text.replace(/^(\s*args\s*=\s*)\[(.*)\](\s*)$/m, (all, pre, inner, post) => {
    const items = JSON.parse(`[${inner}]`);
    const expanded = items.map((a) => (typeof a === 'string' && /^\.\.?[\\/]/.test(a) ? path.resolve(base, a).replace(/\\/g, '/') : a));
    return `${pre}[${expanded.map((a) => JSON.stringify(a)).join(', ')}]${post}`;
  });
}

/** Expand a Claude Code .mcp.json: relative args become absolute paths from <TeamWorkspace>. */
export function expandMcpJson(text, teamWorkspace) {
  const cfg = JSON.parse(text);
  for (const srv of Object.values(cfg.mcpServers || {})) {
    if (Array.isArray(srv.args)) srv.args = srv.args.map((a) => (typeof a === 'string' && /^\.\.?[\\/]/.test(a) ? path.resolve(teamWorkspace, a).replace(/\\/g, '/') : a));
  }
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** Registration layout per provider (where profiles, skills and the MCP registration go). */
export function registrationLayout(provider) {
  if (provider === 'claude') {
    return { agentsDir: '.claude/agents', agentExt: '.md', skillsDir: '.claude/skills', mcpFile: '.mcp.json', mcpSource: 'config/claude.mcp.json', instructions: 'CLAUDE.md', instructionsSource: 'docs/CLAUDE.workspace.md', settings: '.claude/settings.json', settingsSource: 'config/claude.settings.json' };
  }
  return { agentsDir: '.codex/agents', agentExt: '.toml', skillsDir: '.agents/skills', mcpFile: '.codex/config.toml', mcpSource: 'config/codex.toml', instructions: 'AGENTS.md', instructionsSource: 'docs/AGENTS.workspace.md', settings: null, settingsSource: null };
}

export function expandRegistration(provider, text, teamWorkspace) {
  return provider === 'claude' ? expandMcpJson(text, teamWorkspace) : expandCodexConfig(text, teamWorkspace);
}

/** Relative file list (posix separators) of a directory, recursively. */
export function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink/junction not allowed in the pack: ${p}`);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** All payload files of a pack root according to package.json files (plus package.json). */
export function payloadFiles(packRoot, pkg) {
  const files = ['package.json'];
  for (const entry of pkg.files) {
    const p = path.join(packRoot, entry);
    if (entry.endsWith('/')) {
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`declared directory missing: ${entry}`);
      for (const f of walk(p)) files.push(`${entry}${f}`);
    } else {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`declared file missing: ${entry}`);
      files.push(entry);
    }
  }
  return [...new Set(files)].filter((f) => !/(^|\/)\.DS_Store$/.test(f));
}

export function isLinkOrJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
