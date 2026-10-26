#!/usr/bin/env node
// Read-only checker: registration/payload parity, identity/version, manifest/schema, MCP handshake.
// Prints OK/FAIL lines and READY or NOT_READY; exits non-zero on failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJsonStrict, validateIdentity, validateManifest, validatePackageJson, validateProfiles, expandRegistration, registrationLayout, payloadFiles, walk,
  sha256File, REQUIRED_SKILLS, REQUIRED_TOOLS, REQUIRED_PROFILES,
} from '../src/pack-contract.mjs';

function same(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

async function mcpHandshake(runtime, teamWorkspace, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(runtime, 'bin', 'runtime-server.mjs')], { cwd: teamWorkspace, env: { ...process.env, MTM_TEAM_WORKSPACE: teamWorkspace }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    const pending = new Map();
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          clearTimeout(timer);
          child.kill();
          resolve({ ok: false, error: `non-JSON on stdout: ${line.slice(0, 80)}` });
          return;
        }
        pending.get(msg.id)?.(msg);
      }
    });
    const call = (id, method, params) => new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-distribution', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await call(2, 'tools/list', {});
      const status = await call(3, 'tools/call', { name: 'session_status', arguments: {} });
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const names = (list.result?.tools || []).map((t) => t.name);
      const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
      const noSchema = (list.result?.tools || []).filter((t) => !t.inputSchema).map((t) => t.name);
      resolve({ ok: !!init.result && !missing.length && !noSchema.length && !status.result?.isError, server: init.result?.serverInfo, tools: names, missing, noSchema });
    })().catch((e) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ok: false, error: e.message });
    });
  });
}

export async function check({ teamWorkspace, allowPlaceholder = false, source = null, mcp = true } = {}) {
  const lines = [];
  let ok = true;
  const t = (cond, msg, detail) => {
    lines.push(`${cond ? 'OK  ' : 'FAIL'} ${msg}${!cond && detail ? `: ${detail}` : ''}`);
    if (!cond) ok = false;
  };
  const TW = path.resolve(teamWorkspace);
  const runtime = path.join(TW, 'team-sdlc-pack', 'runtime');
  t(fs.existsSync(runtime), 'runtime payload present', runtime);
  if (!fs.existsSync(runtime)) return { ready: false, lines };
  let pkg;
  let info;
  let manifest;
  try {
    pkg = readJsonStrict(path.join(runtime, 'package.json'));
    info = readJsonStrict(path.join(TW, '.mtm', 'team-pack-info.json'));
    manifest = readJsonStrict(path.join(TW, '.mtm', 'team-runtime.json'));
  } catch (e) {
    t(false, 'identity/manifest readable', e.message);
    return { ready: false, lines };
  }
  const pe = validatePackageJson(pkg);
  t(!pe.length, `package.json ${pkg.name}@${pkg.version}`, pe.join('; '));
  const ie = validateIdentity(info, { allowPlaceholder });
  t(!ie.length, `identity ${info.teamId} / ${info.teamName}`, ie.join('; '));
  t(same(path.join(TW, '.mtm', 'team-pack-info.json'), path.join(runtime, 'team-pack-info.json')), 'identity copies identical (.mtm and runtime)');
  t(same(path.join(TW, '.mtm', 'team-runtime.json'), path.join(runtime, 'team-runtime.json')), 'manifest copies identical (.mtm and runtime)');
  const me = validateManifest(manifest, pkg.version);
  t(!me.length, `team-runtime.json provider=${manifest.provider} protocol=${manifest.protocolVersion}`, me.join('; '));
  t(info.version === pkg.version && manifest.version === pkg.version, `versions aligned (${pkg.version})`, `${info.version}/${manifest.version}/${pkg.version}`);
  let files = [];
  try {
    files = payloadFiles(runtime, pkg);
    t(true, `every declared file present (${files.length} files)`);
  } catch (e) {
    t(false, 'every declared file present', e.message);
  }
  if (source) {
    const diff = files.filter((f) => fs.existsSync(path.join(source, f)) && !same(path.join(source, f), path.join(runtime, f)));
    t(!diff.length, 'runtime payload equals the source package', diff.slice(0, 5).join(', '));
  }
  const lay = registrationLayout(manifest.provider);
  const pv = validateProfiles(path.join(runtime, 'agents'));
  t(!pv.errors.length, `agent profiles: ${pv.profiles.map((p) => p.name).join(', ')}`, pv.errors.join('; '));
  const regAgents = path.join(TW, lay.agentsDir);
  const agentFiles = fs.readdirSync(path.join(runtime, 'agents')).filter((f) => f.endsWith(lay.agentExt));
  // Claude Code: the root orchestrator lives in CLAUDE.md, so only the three subagents are .md profiles.
  t(agentFiles.length >= REQUIRED_PROFILES.length - (manifest.provider === 'claude' ? 1 : 0), `${agentFiles.length} ${lay.agentExt} profiles for provider ${manifest.provider}`);
  const agentDiff = agentFiles.filter((f) => !same(path.join(runtime, 'agents', f), path.join(regAgents, f)));
  t(!agentDiff.length, `registered profiles identical to payload (${lay.agentsDir})`, agentDiff.join(', '));
  const extra = fs.existsSync(regAgents) ? fs.readdirSync(regAgents).filter((f) => f.endsWith(lay.agentExt) && !agentFiles.includes(f)) : [];
  if (extra.length) lines.push(`WARN extra profiles in ${lay.agentsDir} not from this pack: ${extra.join(', ')}`);
  // mtm-player's prompt names `.agents/skills/<name>/SKILL.md` for every provider, so the Claude
  // variant must have them there too; Claude Code itself loads `.claude/skills/`.
  const skillDirs = [lay.skillsDir, ...(lay.extraSkillsDirs || [])];
  for (const dir of skillDirs) {
    for (const s of REQUIRED_SKILLS) t(fs.existsSync(path.join(TW, dir, s, 'SKILL.md')), `skill ${s} registered in ${dir}`);
    const skillDiff = [];
    for (const s of fs.readdirSync(path.join(runtime, 'skills'))) {
      for (const f of walk(path.join(runtime, 'skills', s))) if (!same(path.join(runtime, 'skills', s, f), path.join(TW, dir, s, f))) skillDiff.push(`${s}/${f}`);
    }
    t(!skillDiff.length, `registered skills identical to payload (${dir})`, skillDiff.slice(0, 5).join(', '));
  }
  const expected = expandRegistration(manifest.provider, fs.readFileSync(path.join(runtime, lay.mcpSource), 'utf8'), TW);
  const actual = fs.existsSync(path.join(TW, lay.mcpFile)) ? fs.readFileSync(path.join(TW, lay.mcpFile), 'utf8') : null;
  t(actual === expected, `${lay.mcpFile} equals the expanded registration`, actual == null ? 'missing' : 'bytes differ (rerun install)');
  const argPath = (expected.match(/"([^"]*runtime-server\.mjs)"/) || [])[1];
  t(!!argPath && fs.existsSync(argPath), `MCP path exists (${argPath})`);
  try {
    const schema = readJsonStrict(path.join(runtime, 'contracts', 'progress-event.schema.json'));
    t(Array.isArray(schema.oneOf) && schema.oneOf.length >= 14, `progress schema (${schema.oneOf?.length} event types)`);
  } catch (e) {
    t(false, 'progress schema parses', e.message);
  }
  t(fs.existsSync(path.join(TW, 'team-sdlc-pack', 'logs')), 'logs folder present');
  t(fs.existsSync(path.join(TW, 'matches')), 'matches folder present');
  if (mcp) {
    const h = await mcpHandshake(runtime, TW);
    t(h.ok, `MCP initialize + tools/list (${h.server?.name || '?'} ${h.server?.version || ''}; ${h.tools?.length || 0} tools)`, h.error || `missing ${h.missing?.join(',')}${h.noSchema?.length ? `; no inputSchema ${h.noSchema.join(',')}` : ''}`);
  }
  lines.push(`INFO required profiles per guide 0.5.1: ${REQUIRED_PROFILES.join(', ')}`);
  lines.push(`INFO payload sha256(package.json)=${sha256File(path.join(runtime, 'package.json')).slice(0, 16)}`);
  return { ready: ok, lines };
}

async function main() {
  const argv = process.argv.slice(2);
  const o = { teamWorkspace: null, allowPlaceholder: false, source: null, mcp: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--team-workspace' || argv[i] === '-TeamWorkspace') o.teamWorkspace = argv[++i];
    else if (argv[i] === '--allow-placeholder') o.allowPlaceholder = true;
    else if (argv[i] === '--source') o.source = path.resolve(argv[++i]);
    else if (argv[i] === '--no-mcp') o.mcp = false;
  }
  if (!o.teamWorkspace || !path.isAbsolute(o.teamWorkspace)) {
    console.error('usage: node scripts/check-distribution.mjs --team-workspace <absolute path> [--source <pack>] [--allow-placeholder] [--no-mcp]');
    process.exit(2);
  }
  const r = await check(o);
  for (const l of r.lines) console.log(l);
  console.log(r.ready ? 'READY' : 'NOT_READY');
  process.exit(r.ready ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
