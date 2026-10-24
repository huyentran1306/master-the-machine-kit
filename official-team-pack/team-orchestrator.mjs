#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendProgress } from './progress-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const progressFile = path.join(HERE, 'progress.ndjson');

function usage() {
  console.log(`Usage:
  node team-orchestrator.mjs environment-ready --request-id ID --repository REPO --revision SHA --build PASS --match-login PASS
  node team-orchestrator.mjs prepared
  node team-orchestrator.mjs backlog-sync --backlog-id ID --title TITLE
  node team-orchestrator.mjs start-requested --item ID

This helper records local progress only. It never calls an undocumented mtm-player or Game Server API.`);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

function emit(event) {
  const saved = appendProgress(progressFile, event);
  console.log(JSON.stringify(saved));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return usage();
  const o = args(rest);
  if (command === 'environment-ready') return emit({ event: 'ENVIRONMENT_READY', status: 'ENVIRONMENT_READY', requestId: o.requestId, repository: o.repository, revision: o.revision, build: o.build, matchLogin: o.matchLogin });
  if (command === 'prepared') return emit({ event: 'PREPARED', status: 'PREPARED' });
  if (command === 'backlog-sync') return emit({ event: 'BACKLOG_SYNC', status: 'DISCOVERED', backlogId: o.backlogId, title: o.title, revision: null, receiptId: null });
  if (command === 'start-requested') return emit({ event: 'BACKLOG_START_REQUESTED', status: 'REQUESTED', backlogItemKey: o.item });
  throw new Error(`unknown command: ${command}`);
}

try { main(); } catch (error) { console.error(`team-pack error: ${error.message}`); process.exitCode = 1; }
