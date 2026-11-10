#!/usr/bin/env node
import fs from 'node:fs';
import { sendQuery, readyText } from '../src/ready-ping.mjs';

const argv = process.argv.slice(2);
const get = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const tokenFile = get('token-file'); const item = get('item'); const tool = get('tool');
const ready = argv.includes('--ready');
if (!tokenFile || !item || (!tool && !ready)) { console.error('usage: mtm-query --token-file <file> --item <ID> (--tool <read-tool> [--service s] [--query q] | --ready [--waits-for <ID>])'); process.exit(2); }
let auth; try { auth = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { console.error('QUERY_AUTH_INVALID'); process.exit(2); }
if (auth.item !== item) { console.error('ITEM_FORBIDDEN: token belongs to another item'); process.exit(3); }
if (ready) {
  // Ready handshake: the kit checks the committed item and starts shipping it (see RuntimeSession.workerReady).
  const out = await sendQuery(auth, { item, kind: 'ready', waitsFor: get('waits-for') }, { timeoutMs: 90000 });
  process.stdout.write(readyText(out) + '\n');
  process.exit(out.ok || out.error === 'QUERY_TIMEOUT' ? 0 : 5);
}
const args = {};
for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--') && !['--token-file', '--item', '--tool'].includes(argv[i])) args[argv[i].slice(2)] = argv[++i];
const out = await sendQuery(auth, { item, tool, args }, { timeoutMs: 30000 });
if (!out.ok && out.error === 'QUERY_TIMEOUT') { console.error('QUERY_TIMEOUT'); process.exit(4); }
process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(out.ok ? 0 : 5);
