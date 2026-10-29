import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pack = join(fileURLToPath(new URL('..', import.meta.url)), 'team-sdlc-pack');
const read = rel => readFileSync(join(pack, rel), 'utf8');

test('team-orchestrator carries the trap-awareness rules', () => {
  const text = read('skills/team-orchestrator/SKILL.md');
  assert.match(text, /## Trap awareness/);
  assert.match(text, /Source of truth, highest first/);
  assert.match(text, /Lowering the bar is the trap signal/);
  assert.match(text, /fix the code .* and leave the test untouched/);
});

test('no skill tells the agent to fix a test merely because it contradicts the code', () => {
  for (const name of ['team-orchestrator', 'backlog-bug', 'backlog-cr', 'backlog-task']) {
    const text = read(`skills/${name}/SKILL.md`);
    assert.doesNotMatch(text, /fix (it|that test) and record/i, name);
    assert.doesNotMatch(text, /correct that test and say so/i, name);
    assert.doesNotMatch(text, /fix a baseline test that contradicts/i, name);
  }
});

test('the worker profile keeps protective tests and escalates instead', () => {
  assert.match(read('agents/team-feature-worker.toml'), /the code is wrong, not the test/);
});
