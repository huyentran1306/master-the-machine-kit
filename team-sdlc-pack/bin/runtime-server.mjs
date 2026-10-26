#!/usr/bin/env node
// MCP Helper (stdio, newline-delimited JSON-RPC 2.0). Only JSON-RPC goes to stdout; diagnostics go
// to stderr. Implements initialize, notifications/initialized, ping, tools/list, tools/call.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RuntimeSession } from '../src/runtime-session.mjs';
import { TOOLS } from '../src/tools.mjs';
import { drainNetwork } from '../src/http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = path.resolve(HERE, '..');
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESULT_CHARS = 60000;

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

/** TeamWorkspace from a trusted source: env override, install location, or cwd. */
export function detectTeamWorkspace() {
  if (process.env.MTM_TEAM_WORKSPACE) return path.resolve(process.env.MTM_TEAM_WORKSPACE);
  const parts = PACK_ROOT.split(path.sep);
  if (parts.at(-1) === 'runtime' && parts.at(-2) === 'team-sdlc-pack') return path.resolve(PACK_ROOT, '..', '..');
  if (fs.existsSync(path.join(process.cwd(), 'team-sdlc-pack'))) return process.cwd();
  return null;
}

const teamWorkspace = detectTeamWorkspace();
const identity = (teamWorkspace && readJson(path.join(teamWorkspace, '.mtm', 'team-pack-info.json'))) || readJson(path.join(PACK_ROOT, 'team-pack-info.json'));
const adapter = readJson(path.join(PACK_ROOT, 'config', 'game-adapter.json')) || {};
const pkg = readJson(path.join(PACK_ROOT, 'package.json')) || {};
const session = new RuntimeSession({ teamWorkspace, packRoot: PACK_ROOT, adapter, identity });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toolResult(value, isError = false) {
  let text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]`;
  // mtm-player reads HTTP telemetry only from structuredContent.networkActivity (src/http.mjs).
  const networkActivity = drainNetwork();
  const out = { content: [{ type: 'text', text }], isError };
  if (networkActivity.length) out.structuredContent = { networkActivity };
  return out;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mtm-team-runtime', version: pkg.version || '0.0.0' },
          instructions: 'MTM team helper: lifecycle (configure_session), match portal, Start Work/Submit, progress log. Credentials never leave this process.',
        },
      });
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return undefined;
    if (method === 'ping') return isRequest ? send({ jsonrpc: '2.0', id, result: {} }) : undefined;
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id, result: toolResult({ ok: false, error: 'UNKNOWN_TOOL', tools: TOOLS.map((t) => t.name) }, true) });
      const value = await tool.handler(session, params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result: toolResult(value, value?.ok === false && !!value?.error && /^(NOT_CONFIGURED|NO_LIFECYCLE_INPUT|UNKNOWN_TOOL)$/.test(value.error)) });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    process.stderr.write(`[mtm-runtime] ${method}: ${e.stack || e.message}\n`);
    if (isRequest) {
      if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: toolResult(session.clean({ ok: false, error: 'HELPER_EXCEPTION', message: e.message }), true) });
      else send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
  return undefined;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) msg.forEach((m) => handle(m));
  else handle(msg);
});
rl.on('close', () => {
  session.stopPoller();
  session.saveState();
  process.exit(0);
});
process.on('uncaughtException', (e) => process.stderr.write(`[mtm-runtime] uncaught: ${e.stack || e.message}\n`));
process.on('unhandledRejection', (e) => process.stderr.write(`[mtm-runtime] unhandled: ${e?.stack || e}\n`));
