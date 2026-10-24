// Codex hooks: keep-alive while the match runs, guard against moves that lose work, resume context.
// Each case runs tool/hooks.mjs the way Codex does: JSON on stdin, JSON on stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(KIT, 'tool', 'hooks.mjs');
const env0 = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('GIT_CONFIG') && !k.startsWith('MTM_') && k !== 'NODE_TEST_CONTEXT'));

let dir;
let repo;
const m = (...p) => path.join(repo, '.mtm', ...p);
const put = (f, v) => { fs.mkdirSync(path.dirname(m(f)), { recursive: true }); fs.writeFileSync(m(f), JSON.stringify(v)); };

function hook(input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOKS], { input: JSON.stringify({ cwd: repo, ...input }), env: { ...env0, ...extraEnv }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout || '{}');
}
const stop = (msg = 'Done for now.') => hook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const tool = (command, name = 'Bash') => hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { command } });
const denied = (r) => r.hookSpecificOutput?.permissionDecision === 'deny';

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-hooks-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: env0 });
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('outside a match every hook is a no-op, even for a force push', () => {
  assert.deepEqual(stop(), {});
  assert.ok(!denied(tool('git push --force')));
  assert.deepEqual(hook({ hook_event_name: 'SessionStart', source: 'startup' }), {});
});

test('during setup (not ready yet) the agent may stop; after ready it must keep watching', () => {
  put('match.json', { matchId: 'm1', current: null });
  assert.deepEqual(stop(), {}, 'setup with humans at the machine: no keep-alive');
  const probe = JSON.parse(fs.readFileSync(m('hook-probe.json'), 'utf8'));
  assert.equal(probe.event, 'Stop', 'doctor can prove that Codex invoked a hook');
  assert.equal(probe.matchId, 'm1');
  put('match.json', { matchId: 'm1', current: null, armedAt: new Date().toISOString() });
  put('snapshot.json', { status: 'WAITING', items: [], endsAt: null });
  const r = stop();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /has not started yet.*watch --timeout 240/);
  assert.deepEqual(stop('BLOCKED: no push rights on origin/main'), {}, 'BLOCKED before Start may wait for a human');
});

test('mid-match the stop is turned into the next instruction, BLOCKED included', () => {
  put('match.json', { matchId: 'm1', current: 'CR-01', armedAt: new Date().toISOString() });
  put('snapshot.json', { status: 'RUNNING', items: [{ id: 'CR-01' }], endsAt: Date.now() + 20 * 60000, offsetMs: 0 });
  let r = stop('Summary: CR-01 is half done.');
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /^MTM keep-alive: match m1 is still running \(about \d+\.\dm left/);
  assert.match(r.reason, /Current item: CR-01\./);
  assert.match(r.reason, /mtm\.mjs" status and take NEXT/);
  r = stop('BLOCKED: tests do not run');
  assert.match(r.reason, /BLOCKED is not allowed mid-match/);
  assert.equal(stop().decision, 'block', 'still blocking on the next stop');
  assert.deepEqual(hook({ hook_event_name: 'Stop' }, { MTM_ROLE: 'reviewer' }), {}, 'a sub-agent is never kept alive');
});

test('the match end lets the agent stop: finished.json, a finished status, or the end time passed', () => {
  put('finished.json', { matchId: 'M1' });
  assert.deepEqual(stop(), {});
  fs.rmSync(m('finished.json'));
  put('snapshot.json', { status: 'FINISHED', items: [{ id: 'CR-01' }], endsAt: Date.now() });
  assert.deepEqual(stop(), {});
  put('snapshot.json', { status: 'RUNNING', items: [{ id: 'CR-01' }], endsAt: Date.now() - 2 * 60000, offsetMs: 0 });
  assert.deepEqual(stop(), {});
  put('finished.json', { matchId: 'old-match' });
  put('snapshot.json', { status: 'RUNNING', items: [{ id: 'CR-01' }], endsAt: Date.now() + 60000 });
  assert.equal(stop().decision, 'block', 'finished.json of another match does not count');
  fs.rmSync(m('finished.json'));
});

test('a runaway loop is capped', () => {
  put('stop-hook.json', { matchId: 'm1', count: 2 });
  assert.equal(stop().decision, 'block');
  assert.deepEqual(hook({ hook_event_name: 'Stop' }, { MTM_KEEPALIVE_MAX: '3' }), {});
  assert.deepEqual(hook({ hook_event_name: 'Stop' }, { MTM_KEEPALIVE: '0' }), {});
});

test('guard: moves that lose work or break the rules are denied, normal work is not', () => {
  for (const c of ['git push --force', 'git push -f origin main', 'git push origin +main', 'git reset --hard HEAD~1',
    'git clean -fdx', 'git checkout -- .', 'git restore .', 'git stash clear', 'git rebase -i HEAD~3', 'git add -p',
    'Invoke-RestMethod -Method Post http://gm/admin/start', 'Set-Content .mtm\\ledger.json "{}"', 'Remove-Item -Recurse .mtm',
    'Set-Content C:\\Users\\x\\.codex\\hooks.json "{}"']) {
    const r = tool(c);
    assert.ok(denied(r), `denied: ${c}`);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /^MTM guard: /);
  }
  const patch = '*** Begin Patch\n*** Update File: .mtm/ledger.json\n@@\n-{}\n+{"x":1}\n*** End Patch';
  assert.ok(denied(hook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: patch } })));
  const kitEdit = `Set-Content "${path.join(KIT, 'skills', 'mtm-bug', 'SKILL.md')}" x`;
  assert.ok(denied(tool(kitEdit)), 'editing the kit');
  for (const c of ['git status --short', 'git push', 'git push origin HEAD:main', 'git stash push -u -m "WIP CR-01"',
    "git stash pop 'stash@{0}'", 'git clean -fd', 'Get-Content .mtm\\ledger.json', 'rg -n "reset --hard" docs',
    `node "${path.join(KIT, 'tool', 'mtm.mjs').replace(/\\/g, '/')}" fill CR-01 'summary=copy > move the rules'`,
    'Set-Content .mtm\\items\\CR-01\\notes.md "fact: x"', 'git checkout -b fix', 'npm test 2>$null']) {
    assert.ok(!denied(tool(c)), `allowed: ${c}`);
  }
});

test('SessionStart after a restart points the agent at the resume steps', () => {
  const r = hook({ hook_event_name: 'SessionStart', source: 'resume' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.hookSpecificOutput.additionalContext, /match m1 is in progress \(current item: CR-01\).*Resume after a restart/);
});

test('bad input fails open', () => {
  const r = spawnSync(process.execPath, [HOOKS], { input: 'not json', env: env0, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});
