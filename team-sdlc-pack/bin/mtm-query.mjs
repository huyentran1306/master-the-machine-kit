#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const get = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const tokenFile = get('token-file'); const item = get('item'); const tool = get('tool');
if (!tokenFile || !item || !tool) { console.error('usage: mtm-query --token-file <file> --item <ID> --tool <read-tool> [--service s] [--query q]'); process.exit(2); }
let auth; try { auth = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { console.error('QUERY_AUTH_INVALID'); process.exit(2); }
if (auth.item !== item) { console.error('ITEM_FORBIDDEN: token belongs to another item'); process.exit(3); }
const args = {};
for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--') && !['--token-file', '--item', '--tool'].includes(argv[i])) args[argv[i].slice(2)] = argv[++i];
fs.mkdirSync(auth.queueDir, { recursive: true });
const id = crypto.randomUUID(); const req = path.join(auth.queueDir, `${id}.request.json`); const res = path.join(auth.queueDir, `${id}.response.json`);
fs.writeFileSync(req, JSON.stringify({ item, tool, args, token: auth.token }) + '\n', { flag: 'wx' });
const end = Date.now() + 30000;
while (Date.now() < end && !fs.existsSync(res)) await new Promise(r => setTimeout(r, 100));
if (!fs.existsSync(res)) { console.error('QUERY_TIMEOUT'); process.exit(4); }
const out = JSON.parse(fs.readFileSync(res, 'utf8')); try { fs.unlinkSync(res); } catch {}
process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(out.ok ? 0 : 5);
