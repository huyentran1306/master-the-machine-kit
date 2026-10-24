// install.mjs: AGENTS.md block, skills, and hooks merged into an existing hooks.json without losing the user's hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = (...a) => spawnSync(process.execPath, [path.join(KIT, 'install.mjs'), ...a], { encoding: 'utf8' });

test('install, reinstall and uninstall keep the user\'s own AGENTS.md text and hooks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-home-'));
  try {
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# my rules\n');
    const mine = { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo mine' }] }] }, note: 'keep me' };
    fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(mine));

    let r = install('--codex-home', home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+ 3 hooks/);
    assert.match(r.stdout, /\/hooks, review and trust/);
    const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.match(agents, /# my rules/);
    assert.match(agents, /MTM-KIT 0\.3\.2/);
    assert.match(agents, /mtm-kit\/0\.3\.2\/tool\/mtm\.mjs/);
    assert.doesNotMatch(agents, /\{\{(MTM|KIT|SKILLS)\}\}/);
    assert.ok(fs.existsSync(path.join(home, 'skills', 'mtm-cr', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, 'skills', 'mtm-cr', '.mtm-kit-owned.json')));
    assert.ok(fs.existsSync(path.join(home, 'mtm-kit', '0.3.2', 'tool', 'mtm.mjs')));
    assert.ok(fs.existsSync(path.join(home, 'mtm-kit', '0.3.2', 'codex', 'LAUNCH_PROMPT.md')));

    install('--codex-home', home); // twice: no duplicate handlers
    const h = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
    assert.equal(h.note, 'keep me');
    assert.equal(h.hooks.PreToolUse.length, 2);
    assert.equal(h.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    assert.match(h.hooks.PreToolUse[1].hooks[0].command, /^node ".*\/tool\/hooks\.mjs"$/);
    assert.match(h.hooks.PreToolUse[1].hooks[0].command, /mtm-kit\/0\.3\.2\/tool\/hooks\.mjs/);
    assert.equal(h.hooks.Stop.length, 1);
    assert.equal(h.hooks.Stop[0].hooks[0].statusMessage, 'MTM keep-alive');
    assert.equal(h.hooks.SessionStart.length, 1);

    r = install('--codex-home', home, '--uninstall');
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
    assert.deepEqual(after, mine, 'only the user\'s hooks are left');
    assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8').trim(), '# my rules');
    assert.ok(!fs.existsSync(path.join(home, 'skills', 'mtm-cr')));
    assert.ok(!fs.existsSync(path.join(home, 'mtm-kit', '0.3.2')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skill name collisions are backed up and uninstall removes owned files only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-home-'));
  try {
    const collision = path.join(home, 'skills', 'mtm-cr');
    fs.mkdirSync(collision, { recursive: true });
    fs.writeFileSync(path.join(collision, 'user.txt'), 'do not delete');
    let r = install('--codex-home', home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /preserve unowned directory/);
    const backup = fs.readdirSync(path.join(home, 'skills')).find((n) => n.startsWith('mtm-cr.bak-before-mtm-'));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(home, 'skills', backup, 'user.txt'), 'utf8'), 'do not delete');

    // Losing the ownership marker turns a directory back into user-owned data.
    fs.rmSync(path.join(home, 'skills', 'mtm-task', '.mtm-kit-owned.json'));
    r = install('--codex-home', home, '--uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /leave .*mtm-task.*no master-the-machine-dpt-kit ownership marker/);
    assert.ok(fs.existsSync(path.join(home, 'skills', 'mtm-task', 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(home, 'skills', backup, 'user.txt'), 'utf8'), 'do not delete');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--no-hooks installs the rest; a broken hooks.json is left alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-home-'));
  try {
    let r = install('--codex-home', home, '--no-hooks');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no hooks/);
    assert.ok(!fs.existsSync(path.join(home, 'hooks.json')));
    fs.writeFileSync(path.join(home, 'hooks.json'), '{ broken');
    r = install('--codex-home', home);
    assert.match(r.stdout, /not valid JSON: hooks not installed/);
    assert.equal(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), '{ broken');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
