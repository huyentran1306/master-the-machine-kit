// Compare committed trees; working-copy annotations and newly added tests cannot waive baseline changes.
import * as G from './git.mjs';

export const isTestPath = p => /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.[^/]+$/i.test(p);
const strings = v => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
const sourceCitation = s => /\b(?:TASK|CR|BUG|PI)-\d+\b|\bKB[-:/][\w.-]+|\b(?:knowledge[- ]base|design record)\s*[:#]\s*\S+|\b(?:DECISIONS\.md|README(?:\.md)?|specs?\/\S+)/i.test(s);

export async function guardBaseline({ cwd, folder, sha, baseline, answer }) {
  const result = { revision: null, tests: [], migrations: [], errors: [] };
  const scope = `:(literal)${folder.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  result.revision = baseline ? await G.revParse(cwd, baseline) : null;
  if (!result.revision) {
    const history = await G.git(cwd, ['log', '--reverse', '--format=%H', '--diff-filter=A', sha, '--', scope]);
    if (history.code === 0) result.revision = history.stdout.trim().split(/\r?\n/)[0] || null;
  }
  if (!result.revision) {
    result.errors.push('BASELINE_UNAVAILABLE: cannot identify the prepared revision or the first commit that added the assigned folder; restore local Git history and retry.');
    return result;
  }
  const diff = await G.git(cwd, ['diff', '--no-renames', '--name-status', '-z', '--diff-filter=MDT', result.revision, sha, '--', scope]);
  if (diff.code !== 0) {
    result.errors.push('BASELINE_CHECK_FAILED: cannot compare the submitted commit with the match baseline; restore local Git history and retry.');
    return result;
  }
  const annotations = new Map();
  for (const line of strings(answer).flatMap(s => s.split(/\r?\n/))) {
    const m = line.match(/^TEST-CHANGE (.+?):\s*(\S.*)$/);
    if (m && sourceCitation(m[2])) annotations.set(m[1].replace(/\\/g, '/').replace(/^\.\//, ''), m[2]);
  }
  const entries = diff.stdout.split('\0');
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [status, file] = entries.slice(i, i + 2);
    const relative = file.slice(folder.replace(/\\/g, '/').replace(/\/$/, '').length + 1);
    if (/(?:^|\/)migrations\//i.test(relative)) {
      result.migrations.push({ path: file, status });
      result.errors.push(`BASELINE_MIGRATION_CHANGED: ${file} (${status}); revert this path to baseline ${result.revision} and commit again. Add a new migration for the intended change; existing migrations cannot be waived.`);
    }
    if (isTestPath(relative)) {
      result.tests.push({ path: file, status });
      if (!annotations.has(file) && !annotations.has(relative)) result.errors.push(`BASELINE_TEST_CHANGED: ${file} (${status}); revert this path to baseline ${result.revision}, or add a line "TEST-CHANGE ${file}: <source>" to the existing answer analysis/risks field and commit again. Cite the item ID, a knowledge-base document ID (KB-<id>), or a design record (DECISIONS.md, specs/<path>, or design record: <id>) that explicitly requires the behavior change; use a real source, never add template keys.`);
    }
  }
  return result;
}
