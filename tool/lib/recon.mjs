import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './git.mjs';
import { readJson } from './util.mjs';

const IS_WIN = process.platform === 'win32';
const IGNORE = new Set(['.git', '.mtm', 'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.next', '.nuxt', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.gradle', 'vendor', '.angular']);

function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function countFiles(dir, depth = 0) {
  if (depth > 8) return 0;
  let n = 0;
  for (const e of list(dir)) {
    if (IGNORE.has(e.name)) continue;
    n += e.isDirectory() ? countFiles(path.join(dir, e.name), depth + 1) : 1;
  }
  return n;
}

function tree(root, maxDepth = 2) {
  const lines = [];
  const walk = (dir, depth, indent) => {
    const entries = list(dir).filter((e) => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    let files = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/ (${countFiles(path.join(dir, e.name))} files)`);
        if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1, `${indent}  `);
      } else if (depth === 0 || files < 8) {
        lines.push(`${indent}${e.name}`);
        files++;
      }
    }
  };
  walk(root, 0, '');
  return lines.slice(0, 120);
}

function findFiles(root, test, maxDepth = 12, limit = 400) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    for (const e of list(dir)) {
      if (IGNORE.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (test(e.name, p)) out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root, 0);
  return out;
}

const has = (dir, f) => fs.existsSync(path.join(dir, f));

let pyCmd;
/** The Python launcher that really exists here (on Windows py may be missing and python may be the Store shim). */
function python() {
  if (pyCmd) return pyCmd;
  const ok = (c) => spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).status === 0;
  pyCmd = (IS_WIN ? ['py', 'python', 'python3'] : ['python3', 'python']).find(ok) || (IS_WIN ? 'python' : 'python3');
  return pyCmd;
}

/** Detects one build unit (module) in a folder; returns null when the folder has no manifest. */
function detectModule(dir, rel, root = dir) {
  const m = { dir: rel || '.', stack: [], install: [], build: [], test: [], targeted: [], notes: [] };
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const known = ['react', 'next', 'vue', '@angular/core', 'express', '@nestjs/core', '@umijs/max', 'umi',
      'jest', 'vitest', 'mocha', 'karma', 'typescript', '@playwright/test', 'cypress'];
    m.stack.push(`Node${pkg.type === 'module' ? ' (ESM)' : ''}: ${known.filter((k) => deps[k]).join(', ') || 'no notable deps'}`);
    const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : 'npm';
    m.install.push(pm === 'npm' ? (has(dir, 'package-lock.json') ? 'npm ci' : 'npm install') : pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'yarn install --frozen-lockfile');
    const s = pkg.scripts || {};
    if (s.build) m.build.push(`${pm} run build`);
    else if (deps.typescript || has(dir, 'tsconfig.json')) m.build.push('npx tsc --noEmit');
    if (s.test) {
      const t = s.test;
      if (/react-scripts test/.test(t)) { m.test.push(`${pm} test -- --watchAll=false`); m.notes.push('react-scripts test watches by default (mtm evidence sets CI=true)'); }
      else if (/\bvitest\b(?!\s+run)/.test(t)) { m.test.push('npx vitest run'); m.notes.push('vitest watches by default: use "vitest run"'); }
      else if (/\bng test\b/.test(t)) { m.test.push(`${pm} test -- --watch=false --browsers=ChromeHeadless`); m.notes.push('ng test (Karma) watches by default and needs Chrome'); }
      else if (/--watch\b/.test(t)) { m.test.push(`${pm} test`); m.notes.push('test script has --watch: run the runner directly without it'); }
      else m.test.push(`${pm} test`);
      if (deps.jest || /\bjest\b/.test(t) || /react-scripts/.test(t)) m.targeted.push(`npx jest <path> -t "<test name>"`);
      if (deps.vitest) m.targeted.push('npx vitest run <path> -t "<test name>"');
      if (deps.mocha) m.targeted.push('npx mocha <file> --grep "<name>"');
      if (/node --test/.test(t)) m.targeted.push('node --test <file>');
    }
    if (s.lint) m.notes.push(`lint: ${pm} run lint`);
  }
  if (has(dir, 'pom.xml')) {
    m.stack.push('Java Maven');
    m.install.push('mvn -q -B -DskipTests install');
    m.build.push('mvn -q -B -o -DskipTests package');
    m.test.push('mvn -q -B -o test');
    const mvn = has(dir, 'mvnw') || has(dir, 'mvnw.cmd') ? (IS_WIN ? 'mvnw.cmd' : './mvnw') : 'mvn';
    if (mvn !== 'mvn') { m.install[m.install.length - 1] = `${mvn} -q -B -DskipTests install`; m.build[m.build.length - 1] = `${mvn} -q -B -o -DskipTests package`; m.test[m.test.length - 1] = `${mvn} -q -B -o test`; }
    // PowerShell 5.1 splits an unquoted -D argument at its first dot: keep them single-quoted.
    m.targeted.push(`${mvn} -q -B -o '-Dtest=<Class>#<method>' '-Dsurefire.failIfNoSpecifiedTests=false' test (add -pl <module> -am in a multi-module build)`);
  }
  if (has(dir, 'build.gradle') || has(dir, 'build.gradle.kts')) {
    // A subproject uses the wrapper of the root build, run from its own folder (Gradle finds the settings upward).
    const wrapperDir = has(dir, 'gradlew') || has(dir, 'gradlew.bat') ? dir : has(root, 'gradlew') || has(root, 'gradlew.bat') ? root : null;
    const wrap = wrapperDir ? path.relative(dir, path.join(wrapperDir, IS_WIN ? 'gradlew.bat' : 'gradlew')) : null;
    const g = wrap ? (IS_WIN ? wrap.replace(/\//g, '\\') : (wrap.includes('/') ? wrap : `./${wrap}`)) : 'gradle';
    m.stack.push('Java/Kotlin Gradle');
    m.install.push(`${g} build -x test`);
    m.build.push(`${g} build -x test --offline`);
    m.test.push(`${g} test --offline`);
    m.targeted.push(`${g} test --offline --tests <Class>`);
  }
  const sln = list(dir).find((e) => e.name.endsWith('.sln'));
  const csproj = list(dir).filter((e) => e.name.endsWith('.csproj'));
  if (sln || csproj.length) {
    const target = sln ? sln.name : csproj[0].name;
    m.stack.push(`.NET (${sln ? 'solution' : 'project'} ${target})`);
    m.install.push(`dotnet restore ${target}`);
    m.build.push(`dotnet build ${target} --no-restore`);
    m.test.push(`dotnet test ${target} --no-restore`);
    m.targeted.push(`dotnet test ${target} --no-restore --filter "FullyQualifiedName~<Class>"`);
  }
  if (has(dir, 'pyproject.toml') || has(dir, 'requirements.txt') || has(dir, 'setup.py')) {
    const py = python();
    m.stack.push('Python');
    if (has(dir, 'requirements.txt')) m.install.push(`${py} -m pip install -r requirements.txt`);
    else m.install.push(`${py} -m pip install -e .`);
    m.test.push(`${py} -m pytest -q`);
    m.targeted.push(`${py} -m pytest -q <file>::<test> (or -k "<name>")`);
    if (IS_WIN) m.notes.push(`Windows: commands use "${py}", the Python launcher found on this machine`);
  }
  if (has(dir, 'go.mod')) { m.stack.push('Go'); m.install.push('go mod download'); m.test.push('go test ./...'); m.targeted.push('go test ./<pkg> -run <Name>'); }
  if (has(dir, 'Cargo.toml')) { m.stack.push('Rust'); m.install.push('cargo fetch'); m.build.push('cargo build'); m.test.push('cargo test'); m.targeted.push('cargo test <name>'); }
  if (has(dir, 'composer.json')) {
    m.stack.push('PHP Composer');
    m.install.push('composer install');
    m.test.push(IS_WIN ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit');
    m.targeted.push(`${IS_WIN ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit'} --filter <name>`);
  }
  return m.stack.length ? m : null;
}

function readJsonSafe(file) {
  try { return readJson(file, null); } catch { return null; }
}

/** Build units at the root and up to two folder levels down (monorepos: frontend/, backend/, services/x). */
export function detectModules(root) {
  const mods = [];
  const visit = (dir, rel, depth) => {
    if (mods.length >= 12) return;
    const m = detectModule(dir, rel, root);
    if (m) mods.push(m);
    if (depth >= 2 || mods.length >= 12) return;
    for (const e of list(dir)) {
      if (!e.isDirectory() || IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      visit(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  visit(root, '', 0);
  return mods;
}

/** Kept for compatibility: stack names and test commands of all modules. */
export function detectStack(root) {
  const mods = detectModules(root);
  return {
    stack: mods.map((m) => `${m.dir}: ${m.stack.join(' + ')}`),
    commands: mods.flatMap((m) => m.test.map((t) => (m.dir === '.' ? t : `--cwd ${m.dir} -- ${t}`))),
  };
}

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.(py|go)$|(Test|Tests|IT)\.(java|kt|cs)$|Spec\.(groovy|kt)$/;

export function buildRepoMap(root) {
  const mods = detectModules(root);
  const tests = findFiles(root, (n) => TEST_FILE.test(n));
  const roots = [...new Set(tests.map((t) => {
    const parts = t.split('/');
    const i = parts.findIndex((p) => /^(test|tests|__tests__|spec|src)$/i.test(p));
    return parts.slice(0, i >= 0 ? i + 1 : Math.min(parts.length - 1, 2)).join('/') || '.';
  }))].slice(0, 8);
  const logs = findFiles(root, (n) => /\.log$/i.test(n), 3, 20);
  const docs = findFiles(root, (n) => /^(readme|contributing|changelog|agents|claude)/i.test(n), 2, 10);
  const log = git(root, ['log', '--oneline', '-12'], { allowFail: true }) || '(no git history)';
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  const remote = git(root, ['remote'], { allowFail: true });
  const modLines = mods.length ? mods.flatMap((m) => [
    `### ${m.dir}: ${m.stack.join(' + ')}`,
    ...m.install.map((c) => `- install: ${c}`),
    ...m.build.map((c) => `- build: ${c}`),
    ...m.test.map((c) => `- test: ${c}`),
    ...m.targeted.map((c) => `- one test: ${c}`),
    ...m.notes.map((c) => `- note: ${c}`),
  ]) : ['- no manifest found to depth 2: list build files with rg --files -g pom.xml -g package.json -g "*.csproj" -g "build.gradle*"'];
  return [
    `# Repo map (generated by mtm recon, ${new Date().toISOString()})`,
    '',
    `Branch: ${branch || '?'}  Remotes: ${remote ? remote.split(/\s+/).join(', ') : 'none'}  Modules: ${mods.length}`,
    'Commands run in the module folder: MTM evidence <ID> --cwd <module> -- <command> (sets CI=true, so test runners do not watch; on Windows it runs under cmd.exe, so give arguments separately).',
    '',
    '## Modules',
    ...modLines,
    '',
    `## Tests (${tests.length}${tests.length >= 400 ? '+' : ''} files) in: ${roots.join(', ') || '-'}`,
    ...tests.slice(0, 12).map((t) => `- ${t}`),
    '',
    '## Logs and agent docs',
    ...[...logs, ...docs].map((t) => `- ${t}`),
    '',
    '## Recent commits',
    ...log.split(/\r?\n/).map((l) => `- ${l}`),
    '',
    '## Tree (depth 2)',
    '```',
    ...tree(root),
    '```',
    '',
  ].join('\n');
}
