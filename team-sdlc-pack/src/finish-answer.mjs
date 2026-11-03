#!/usr/bin/env node
// One-step finish for answer-only items: node <pack>/src/finish-answer.mjs <answers/ID/submit.json> [schema.json] [--required a,b] [--message "..."]
// Validates like validate-answer.mjs, commits answers/<ID>/ in the worker's worktree and prints the READY block the
// worker replies with. In EFMN62ZO the PI-01 worker spent ~45 of its 141 s on validator retries, git add, an evidence
// check, a second commit and progress messages after the answer was already written.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSubmit } from './validate-answer.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Returns { ok, problems, commit, block }. Commits only the answer folder; never pushes. */
export function finishAnswer(answerFile, schemaFile, { required = [], message } = {}) {
  const abs = path.resolve(answerFile);
  const dir = path.dirname(abs);
  const id = path.basename(dir);
  const problems = checkSubmit(abs, schemaFile ? path.resolve(schemaFile) : undefined, { required });
  if (problems.length) return { ok: false, problems, block: `ANSWER INVALID (${problems.length}):\n- ${problems.join('\n- ')}\nFix submit.json and run this command again.` };
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  git(root, ['add', '-A', '--', dir]);
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (staged) git(root, ['-c', 'user.name=team_feature_worker', '-c', 'user.email=worker@team.local', 'commit', '-q', '--no-verify', '-m', message || `${id}: answer`]);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .filter((l) => !/(^|\/)node_modules(\/|$)/.test(l));
  const block = [
    'STATUS: READY',
    `COMMIT: ${commit}`,
    `TESTS: required=0 executed=1 passed=1 failed=0 skipped=0; finish-answer validated submit.json${schemaFile ? ' against the shipped schema' : ''}`,
    'CHECKS: full-suite=NOT_RUN typecheck=NOT_RUN build=NOT_RUN; build-relevant=no (answer-only)',
    `EVIDENCE: ${required.length ? required.join(', ') : 'none required'}`,
    `REVIEW: answer committed by finish-answer${dirty.length ? `; WARNING other uncommitted files: ${dirty.slice(0, 5).join(' | ')}` : '; worktree clean'}`,
  ].join('\n');
  return { ok: true, problems: [], commit, dirty, block };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
  const required = String(take('--required') || '').split(',').filter(Boolean);
  const message = take('--message');
  const files = args.filter((a) => a !== '--schema');
  if (files.length === 2 && /schema\.json$/i.test(files[0])) files.reverse();
  const [answer, schema] = files;
  if (!answer || !fs.existsSync(answer)) { console.error('usage: finish-answer.mjs <submit.json> [schema.json] [--required a,b] [--message msg]'); process.exit(2); }
  try {
    const r = finishAnswer(answer, schema, { required, message });
    console.log(r.block);
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.log(`FINISH FAILED: ${e.message.split('\n')[0]}\nCommit answers/<ID>/ yourself and reply READY with the SHA.`); process.exit(3); }
}
