import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const matchRoot = path.join(root, 'IR01');
  fs.mkdirSync(path.join(matchRoot, 'answers', 'BUG-04', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(matchRoot, 'answers', 'BUG-04', 'submit.json'), '{}');
  const s = Object.create(RuntimeSession.prototype);
  s.checkoutRoot = root; s.matchRoot = matchRoot; s.items = new Map();
  return { s, root, matchRoot };
}

test('a just-started item draft in main moves to its worktree before ship', async t => {
  const { s, root, matchRoot } = setup(t);
  const wtMatch = path.join(root, '.mtm-wt', 'BUG-04', 'IR01'); fs.mkdirSync(wtMatch, { recursive: true });
  s.items.set('BUG-04', { id: 'BUG-04', local: { worktree: { matchRoot: wtMatch } } });
  assert.equal(await s.relocateDraftAnswers(['?? IR01/answers/BUG-04/'], 'BUG-02'), true);
  assert.ok(fs.existsSync(path.join(wtMatch, 'answers', 'BUG-04', 'submit.json')));
  assert.ok(!fs.existsSync(path.join(matchRoot, 'answers', 'BUG-04')));
});

test('without a worktree the draft is parked in .mtm-notes/drafts', async t => {
  const { s, root, matchRoot } = setup(t);
  assert.equal(await s.relocateDraftAnswers(['?? IR01/answers/BUG-04/submit.json', '?? IR01/answers/BUG-04/checklist.md'], 'BUG-02'), true);
  assert.ok(!fs.existsSync(path.join(matchRoot, 'answers', 'BUG-04')));
  assert.equal(fs.readdirSync(path.join(root, '.mtm-notes', 'drafts')).filter(n => n.startsWith('BUG-04-')).length, 1);
});

test('real main changes and the shipping item itself stay MAIN_DIRTY', async t => {
  const { s } = setup(t);
  assert.equal(await s.relocateDraftAnswers([' M IR01/src/app.ts'], 'BUG-02'), false);
  assert.equal(await s.relocateDraftAnswers(['?? IR01/answers/BUG-02/'], 'BUG-02'), false);
});
