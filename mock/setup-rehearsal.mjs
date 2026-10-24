#!/usr/bin/env node
// Creates a rehearsal "customer system": <dir>/remote.git (bare, plays the team repo on Game Master)
// and <dir>/workspace (the clone the agent works in). History: initial service + a VIP release
// that carries the production incident.
//   node setup-rehearsal.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || path.join(HERE, '..', 'rehearsal'));
const remote = path.join(target, 'remote.git');
const ws = path.join(target, 'workspace');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')));
const id = ['-c', 'user.name=Customer Dev', '-c', 'user.email=dev@customer.example', '-c', 'commit.gpgsign=false'];

function git(cwd, argv) {
  return execFileSync('git', argv, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function copyDir(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); } else fs.copyFileSync(s, d);
  }
}

if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`${target} is not empty; pick a new folder or delete it first.`);
  process.exit(1);
}
fs.mkdirSync(ws, { recursive: true });
git(target, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
git(ws, ['init', '--quiet', '-b', 'main']);
copyDir(path.join(HERE, 'practice-repo', 'base'), ws);
git(ws, ['add', '-A']);
git(ws, [...id, 'commit', '--quiet', '-m', 'voucher-service 1.3: redeem API']);
copyDir(path.join(HERE, 'practice-repo', 'vip-release'), ws);
git(ws, ['add', '-A']);
git(ws, [...id, 'commit', '--quiet', '-m', 'feat: VIP-only vouchers (release 1.4.0)']);
git(ws, ['remote', 'add', 'origin', remote]);
git(ws, ['push', '--quiet', '-u', 'origin', 'main']);
// The agent's own commits need an identity (mtm doctor checks it).
git(ws, ['config', 'user.name', 'DPT Agent']);
git(ws, ['config', 'user.email', 'dpt-agent@team.example']);
console.log(`remote:    ${remote}\nworkspace: ${ws}`);
