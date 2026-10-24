// Secrets and competition-only guardrails that must not regress silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MTM = path.join(KIT, 'tool', 'mtm.mjs');

test('init never prints the token and restricts session.json on POSIX', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-secret-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const secret = 'should-not-appear-in-output';
    const env = { ...process.env, CODEX_HOME: path.join(dir, 'codex-home'), MTM_REPO: dir };
    const r = spawnSync(process.execPath, [MTM, 'init', '--base-url', 'https://gm.invalid', '--match', 'round-1', '--token', secret], {
      cwd: dir, env, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, new RegExp(secret));
    const session = path.join(dir, '.mtm', 'session.json');
    assert.equal(JSON.parse(fs.readFileSync(session, 'utf8')).token, secret);
    if (process.platform !== 'win32') assert.equal(fs.statSync(session).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
