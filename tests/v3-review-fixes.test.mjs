import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';

const pack = join(fileURLToPath(new URL('..', import.meta.url)), 'team-sdlc-pack');
const read = rel => readFileSync(join(pack, rel), 'utf8');
const profiles = ['team-feature-worker.toml', 'team-quality-checker.toml', 'team-repo-scout.toml'];

test('every subagent profile carries the core rules it can no longer inherit', () => {
  for (const file of profiles) {
    const text = read(`agents/${file}`);
    assert.match(text, /start without the parent's history/, file);
    assert.match(text, /Never call spawn_agent/, file);
    assert.match(text, /never `&&`\/`\|\|`/, file);
  }
  const worker = read('agents/team-feature-worker.toml');
  assert.match(worker, /Use what the organizer shipped/);
  assert.match(worker, /Trap signal/);
  assert.match(worker, /\.mtm-notes\/<ID>-brief\.md/);
  const checker = read('agents/team-quality-checker.toml');
  assert.match(checker, /git status --short -- "<folder>"/);
  assert.match(checker, /in-scope baseline fixes/);
  assert.match(checker, /Trap checks/);
});

test('the scout only reads git history scoped to the assigned folder', () => {
  const scout = read('agents/team-repo-scout.toml');
  assert.match(scout, /log --oneline -15 -- "<folder>"/);
  assert.match(scout, /show --stat <sha> -- "<folder>\/"/);
  assert.doesNotMatch(scout, /git log --oneline -15 and git show --stat <sha> for/);
  assert.match(read('skills/backlog-pi/SKILL.md'), /checkoutRoot, folder and matchRoot/);
});

test('Trap awareness sits after the match loop, not inside it', () => {
  const text = read('skills/team-orchestrator/SKILL.md');
  const trap = text.indexOf('## Trap awareness');
  assert.ok(trap > text.indexOf('9. After `SUBMITTED`'), 'loop steps 5-9 must precede Trap awareness');
  assert.ok(trap > text.indexOf('## Never'), 'Trap awareness should follow the Never list');
});

test('a schema-level baseline fix is documented as schema rule plus new migration', () => {
  assert.match(read('skills/stack-nextjs-prisma/SKILL.md'), /migrate dev --create-only/);
  assert.match(read('skills/team-orchestrator/SKILL.md'), /`onDelete`, AND add a new migration/);
});

test('worktree brief is written inside the worktree with copies of the organizer files', t => {
  const root = mkdtempSync(join(tmpdir(), 'mtm-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', checkout]);
  const wtRoot = join(checkout, '.mtm-wt', 'CR-09');
  const fake = {
    checkoutRoot: checkout,
    readMaterial: () => ({
      backlogType: 'CR', startInstruction: 'Run the shipped runner.',
      minimumVerificationScenarios: '# CR-09 MVS\n- CR-09-TC-01',
      submitTemplate: { backlogId: 'CR-09', status: 'NOT_STARTED' },
      files: { 'challenge/CR-09-run-checks.mjs': 'console.log(1)', '../escape.txt': 'nope' },
    }),
  };
  const out = RuntimeSession.prototype.writeWorkerBrief.call(fake, { id: 'CR-09', type: 'CR', title: 'Export', description: 'Do the export.' }, wtRoot);
  const brief = readFileSync(out.briefFile, 'utf8');
  assert.match(brief, /Do the export\./);
  assert.match(brief, /CR-09-TC-01/);
  assert.match(brief, /Run the shipped runner\./);
  assert.ok(existsSync(join(out.filesDir, 'challenge', 'CR-09-run-checks.mjs')));
  assert.deepEqual(out.files, ['challenge/CR-09-run-checks.mjs'], 'paths escaping the files folder are skipped');
  assert.match(readFileSync(join(checkout, '.git', 'info', 'exclude'), 'utf8'), /\/\.mtm-notes\//);
});

test('submit_work refuses a second concurrent call for the same item', async () => {
  const pending = new Map();
  const fake = {
    submitWorkOnce: ({ backlogItemKey }) => new Promise(resolve => {
      pending.set(backlogItemKey, () => resolve({ ok: true, outcome: 'SUBMITTED', id: backlogItemKey }));
    }),
  };
  const first = RuntimeSession.prototype.submit_work.call(fake, { backlogItemKey: 'BUG-03' });
  const second = await RuntimeSession.prototype.submit_work.call(fake, { backlogItemKey: 'BUG-03' });
  assert.equal(second.error, 'SUBMIT_IN_PROGRESS');
  const other = RuntimeSession.prototype.submit_work.call(fake, { backlogItemKey: 'CR-04' });
  assert.ok(pending.has('CR-04'), 'another item is not blocked by the BUG-03 lock');
  pending.get('BUG-03')();
  assert.equal((await first).id, 'BUG-03');
  pending.get('CR-04')();
  assert.equal((await other).id, 'CR-04');
  const again = RuntimeSession.prototype.submit_work.call(fake, { backlogItemKey: 'BUG-03' });
  pending.get('BUG-03')();
  assert.equal((await again).outcome, 'SUBMITTED', 'the lock is released after the first call returns');
});

test('submit retry budget leaves room under the 120 s tool timeout', () => {
  const adapter = JSON.parse(read('config/game-adapter.json'));
  assert.ok(adapter.submit.retryBudgetMs <= 60000);
});
