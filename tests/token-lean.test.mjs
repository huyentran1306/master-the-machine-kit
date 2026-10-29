import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pack = join(fileURLToPath(new URL('..', import.meta.url)), 'team-sdlc-pack');
const read = rel => readFileSync(join(pack, rel), 'utf8');

const spawningSkills = ['team-orchestrator', 'backlog-bug', 'backlog-cr', 'backlog-pi', 'backlog-task'];

test('every skill that spawns a subagent asks for fork_turns "none"', () => {
  for (const name of spawningSkills) {
    const text = read(`skills/${name}/SKILL.md`);
    assert.match(text, /fork_turns: "none"/, `${name} must spawn subagents without parent history`);
  }
});

test('team-orchestrator explains the self-contained brief and file handoff', () => {
  const text = read('skills/team-orchestrator/SKILL.md');
  assert.match(text, /Always call `spawn_agent` with `fork_turns: "none"`/);
  assert.match(text, /\.mtm-notes\//);
});

test('subagent profiles forbid nested spawn_agent', () => {
  for (const file of ['team-feature-worker.toml', 'team-quality-checker.toml', 'team-repo-scout.toml']) {
    assert.match(read(`agents/${file}`), /Never call spawn_agent/, `${file} must forbid nested subagents`);
  }
});
