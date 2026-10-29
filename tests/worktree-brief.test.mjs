import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeItemBrief } from '../team-sdlc-pack/src/item-brief.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const material = {
  startInstruction: 'Run the supplied verifier.', minimumVerificationScenarios: [{ id: 'CR-07-TC-01', evidence: 'result.json' }],
  submitTemplate: { backlogId: 'CR-07', status: 'DRAFT' },
  files: { 'qa/data.json': '{"input":7}\r\n', 'qa/run-checks.mjs': "import data from './data.json';\n", 'qa/schema.json': { type: 'object' } },
};
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-brief-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  const matchRoot = path.join(root, 'assigned');
  fs.mkdirSync(matchRoot);
  return { checkoutRoot: root, matchRoot, item: { id: 'CR-07', type: 'CR', title: 'Export', description: 'Export all rows.', acceptanceCriteria: ['All rows'] }, material };
}

test('brief writer keeps item, MVS, template and exact organizer contents inside matchRoot', t => {
  const args = setup(t);
  const result = writeItemBrief(args);
  const brief = JSON.parse(fs.readFileSync(result.briefFile, 'utf8'));
  assert.deepEqual(brief.item, args.item);
  for (const key of ['startInstruction', 'minimumVerificationScenarios', 'submitTemplate']) assert.deepEqual(brief[key], material[key]);
  for (const [name, file] of Object.entries(result.files)) {
    assert.ok(file.startsWith(args.matchRoot + path.sep));
    assert.equal(fs.readFileSync(file, 'utf8'), typeof material.files[name] === 'string' ? material.files[name] : JSON.stringify(material.files[name], null, 2));
    assert.ok(git(args.checkoutRoot, 'check-ignore', file));
  }
  assert.ok(git(args.checkoutRoot, 'check-ignore', result.briefFile));
  assert.equal(git(args.checkoutRoot, 'status', '--short'), '');
});

test('brief writer rejects escaping paths and missing Start Work material', t => {
  const args = setup(t);
  for (const name of ['../escape', 'nested/../../escape', '..\\escape', '/absolute', 'C:\\escape', '\\\\host\\share', 'nested/./file']) {
    assert.throws(() => writeItemBrief({ ...args, material: { ...material, files: { [name]: 'bad' } } }), /Unsafe brief path/);
  }
  assert.throws(() => writeItemBrief({ ...args, material: null }), /Start Work material is missing/);
  assert.throws(() => writeItemBrief({ ...args, item: { id: '../escape' } }), /Unsafe brief path/);
  assert.equal(fs.existsSync(path.join(args.checkoutRoot, 'escape')), false);
});

test('worktree create returns ignored, readable child paths and moves only the draft answer', async t => {
  const args = setup(t);
  git(args.checkoutRoot, 'config', 'user.name', 'Fixture');
  git(args.checkoutRoot, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(args.matchRoot, 'app.txt'), 'baseline');
  git(args.checkoutRoot, 'add', 'assigned');
  git(args.checkoutRoot, 'commit', '-qm', 'baseline');
  const s = new RuntimeSession({ teamWorkspace: args.checkoutRoot });
  s.checkoutRoot = args.checkoutRoot; s.matchRoot = args.matchRoot;
  s.repository = { folder: 'assigned' }; s.materialCache = { 'CR-07': material };
  s.items.set('CR-07', { ...args.item, local: { startedAt: Date.now() } });
  const draft = path.join(args.matchRoot, 'answers', 'CR-07');
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'checklist.md'), 'Check every row');
  const out = await s.worktree({ action: 'create', backlogItemKey: 'CR-07' });
  assert.equal(out.ok, true);
  assert.equal(out.checkoutRoot, out.worktreeRoot);
  assert.equal(out.folder, 'assigned');
  assert.ok(out.brief.briefFile.startsWith(out.matchRoot + path.sep));
  assert.equal(fs.readFileSync(path.join(out.answer.dir, 'checklist.md'), 'utf8'), 'Check every row');
  assert.equal(fs.existsSync(draft), false);
  assert.ok(git(out.worktreeRoot, 'check-ignore', out.brief.briefFile));
  assert.doesNotMatch(git(out.worktreeRoot, 'status', '--short', '--untracked-files=all'), /mtm-briefs/);
  assert.match(out.next, /fork_turns:"none"/);
  assert.ok(out.next.includes(out.brief.briefFile));
  assert.ok(out.next.includes(out.brief.filesDir));
  assert.deepEqual(JSON.parse(fs.readFileSync(out.brief.briefFile, 'utf8')).submitTemplate, material.submitTemplate);
});
