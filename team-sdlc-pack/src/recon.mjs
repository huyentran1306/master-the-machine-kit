// Repository recon: a compact map of toolchain, commands and notable folders, so the model does
// not spend tokens exploring. Read-only.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.turbo', '.pnpm-store', 'answers']);

function list(dir, depth, out = [], rel = '') {
  if (depth < 0) return out;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (SKIP.has(e.name) || (e.name.startsWith('.') && !['.env.example', '.nvmrc', '.node-version', '.env.sample', '.github'].includes(e.name))) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push({ rel: r, dir: e.isDirectory() });
    if (e.isDirectory()) list(path.join(dir, e.name), depth - 1, out, r);
  }
  return out;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

function nodeProject(root, rel) {
  const dir = path.join(root, rel);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return null;
  const has = (f) => fs.existsSync(path.join(dir, f)) || fs.existsSync(path.join(root, f));
  let pm = pkg.packageManager ? pkg.packageManager.split('@')[0] : null;
  if (!pm) pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
  const lock = has('pnpm-lock.yaml') || has('yarn.lock') || has('package-lock.json');
  const install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: lock ? 'npm ci' : 'npm install', bun: 'bun install' }[pm];
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frameworks = ['next', 'react', 'vue', 'svelte', '@angular/core', 'express', 'fastify', 'nestjs', '@nestjs/core', 'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'mongoose', 'tailwindcss']
    .filter((d) => deps[d]);
  const testTools = ['vitest', 'jest', 'mocha', '@playwright/test', 'playwright', 'cypress', '@testing-library/react', 'supertest'].filter((d) => deps[d]);
  const pick = (names) => names.find((n) => scripts[n]);
  return {
    path: rel || '.',
    name: pkg.name || null,
    version: pkg.version || null,
    packageManager: pkg.packageManager || pm,
    engines: pkg.engines?.node || null,
    install,
    build: pick(['build']) ? run('build') : null,
    test: pick(['test', 'test:unit', 'unit']) ? (scripts.test && pm === 'npm' ? 'npm test' : run(pick(['test', 'test:unit', 'unit']))) : null,
    typecheck: pick(['typecheck', 'type-check', 'tsc', 'check-types']) ? run(pick(['typecheck', 'type-check', 'tsc', 'check-types'])) : (deps.typescript ? `${pm === 'npm' ? 'npx' : pm + ' exec'} tsc --noEmit` : null),
    lint: pick(['lint']) ? run('lint') : null,
    e2e: pick(['e2e', 'test:e2e']) ? run(pick(['e2e', 'test:e2e'])) : null,
    dev: pick(['dev', 'start']) ? run(pick(['dev', 'start'])) : null,
    audit: pm === 'pnpm' ? 'pnpm audit --prod' : pm === 'yarn' ? 'yarn npm audit --environment production' : 'npm audit --omit=dev',
    frameworks,
    testTools,
    scripts: Object.keys(scripts).slice(0, 25),
  };
}

/** MTM match folders ship a fixed envelope: exam-info.json, answers/, env-require/, and the app in src/. */
function matchEnvelope(matchRoot) {
  const has = (p) => fs.existsSync(path.join(matchRoot, p));
  const env = {
    examInfo: has('exam-info.json') ? readJson(path.join(matchRoot, 'exam-info.json')) : null,
    answersDir: has('answers'),
    envRequire: null,
    appDir: null,
  };
  if (has('env-require')) {
    const dir = path.join(matchRoot, 'env-require');
    env.envRequire = {
      path: 'env-require',
      files: fs.readdirSync(dir).filter((f) => !f.startsWith('.')),
      requirements: fs.existsSync(path.join(dir, 'requirements.json')) ? readJson(path.join(dir, 'requirements.json')) : null,
      readme: fs.existsSync(path.join(dir, 'README.md')) ? 'env-require/README.md' : null,
      doctor: fs.existsSync(path.join(dir, 'doctor.ps1')) ? 'env-require/doctor.ps1' : null,
      setup: fs.existsSync(path.join(dir, 'setup.ps1')) ? 'env-require/setup.ps1' : null,
      prepareSource: fs.existsSync(path.join(dir, 'prepare-source.ps1')) ? 'env-require/prepare-source.ps1' : null,
      dbSetup: fs.existsSync(path.join(dir, 'db-setup.sql')) ? 'env-require/db-setup.sql' : null,
    };
  }
  const PROJECT_FILES = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'composer.json', 'Gemfile', 'mix.exs'];
  const isProject = (dir) => PROJECT_FILES.some((f) => has(path.join(dir, f))) || (fs.existsSync(path.join(matchRoot, dir)) && fs.readdirSync(path.join(matchRoot, dir)).some((f) => /\.(sln|csproj|fsproj)$/.test(f)));
  if (!PROJECT_FILES.some((f) => has(f)) && !fs.readdirSync(matchRoot).some((f) => /\.(sln|csproj)$/.test(f))) {
    for (const c of ['src', 'app', 'application', 'service', 'backend', 'server', 'api', 'web', 'frontend']) {
      if (fs.existsSync(path.join(matchRoot, c)) && isProject(c)) {
        env.appDir = c;
        break;
      }
    }
  }
  return env;
}

/** Commands a CI workflow actually runs: the most reliable source when the stack is unfamiliar. */
function ciCommands(matchRoot) {
  const out = [];
  const dirs = [path.join(matchRoot, '.github', 'workflows'), path.join(matchRoot, '.gitlab-ci.yml'), path.join(matchRoot, 'azure-pipelines.yml'), path.join(matchRoot, 'Jenkinsfile'), path.join(matchRoot, 'Makefile')];
  const take = (file) => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:-\s*)?(?:run:\s*|RUN\s+|\t)(.+?)\s*$/);
      const cmd = (m ? m[1] : '').replace(/^["']|["']$/g, '');
      if (!cmd || cmd.length > 160 || /^\|/.test(cmd)) continue;
      if (/\b(install|ci|restore|build|test|lint|typecheck|check|migrate|seed|compile|package|verify)\b/.test(cmd) && !/actions\//.test(cmd)) {
        out.push({ from: path.relative(matchRoot, file).split(path.sep).join('/'), cmd });
      }
    }
  };
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    if (fs.statSync(d).isDirectory()) for (const f of fs.readdirSync(d).filter((x) => /\.ya?ml$/.test(x))) take(path.join(d, f));
    else take(d);
  }
  return out.slice(0, 25);
}

const OTHER_STACKS = [
  { stack: 'java-maven', when: (n) => n.some((x) => /(^|\/)pom\.xml$/.test(x)), install: 'mvn -q -B -o dependency:go-offline', build: 'mvn -q -B -DskipTests package', test: 'mvn -q -B test', one: 'mvn -q -B test -Dtest=<Class>#<method>' },
  { stack: 'java-gradle', when: (n) => n.some((x) => /(^|\/)build\.gradle(\.kts)?$/.test(x)), install: 'gradlew --offline dependencies', build: 'gradlew build -x test', test: 'gradlew test', one: 'gradlew test --tests "<Class>"' },
  { stack: 'dotnet', when: (n) => n.some((x) => /\.(sln|csproj)$/.test(x)), install: 'dotnet restore', build: 'dotnet build --no-restore', test: 'dotnet test --no-build', one: 'dotnet test --filter "FullyQualifiedName~<Name>"' },
  { stack: 'python', when: (n) => n.some((x) => /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/.test(x)), install: 'python -m pip install -r requirements.txt', build: null, test: 'python -m pytest -q', one: 'python -m pytest -q <file>::<test>' },
  { stack: 'go', when: (n) => n.some((x) => /(^|\/)go\.mod$/.test(x)), install: 'go mod download', build: 'go build ./...', test: 'go test ./...', one: 'go test ./<pkg> -run <Name>' },
  { stack: 'rust', when: (n) => n.some((x) => /(^|\/)Cargo\.toml$/.test(x)), install: 'cargo fetch', build: 'cargo build', test: 'cargo test', one: 'cargo test <name>' },
  { stack: 'php', when: (n) => n.some((x) => /(^|\/)composer\.json$/.test(x)), install: 'composer install --no-interaction', build: null, test: 'vendor/bin/phpunit', one: 'vendor/bin/phpunit --filter <Name>' },
  { stack: 'ruby', when: (n) => n.some((x) => /(^|\/)Gemfile$/.test(x)), install: 'bundle install', build: null, test: 'bundle exec rspec', one: 'bundle exec rspec <file>:<line>' },
];

export function recon(matchRoot) {
  const files = list(matchRoot, 3);
  const names = files.map((f) => f.rel);
  const envelope = matchEnvelope(matchRoot);
  const projects = [];
  for (const rel of ['', ...names.filter((n) => n.endsWith('/package.json') && n.split('/').length <= 3).map((n) => n.slice(0, -'/package.json'.length))]) {
    const p = nodeProject(matchRoot, rel);
    if (p) projects.push(p);
  }
  const other = OTHER_STACKS.filter((o) => o.when(names)).map(({ when, ...rest }) => rest);
  const nvmrc = ['.nvmrc', '.node-version'].map((f) => path.join(matchRoot, f)).find((f) => fs.existsSync(f));
  let app = projects.find((p) => p.path === (envelope.appDir || '.')) || projects[0] || null;
  if (!app && other.length) {
    // Non-Node stack: commands come from the stack table, refined by CI below.
    const o = other[0];
    app = { path: envelope.appDir || '.', name: null, stack: o.stack, install: o.install, build: o.build, test: o.test, typecheck: null, lint: null, audit: null, oneTest: o.one };
  }
  const envText = ['.env.example', '.env.sample'].map((f) => path.join(matchRoot, envelope.appDir || '.', f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const envKeys = [...new Set([...envText.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]))];
  const deps = app ? [...(app.frameworks || []), ...(app.testTools || [])] : [];
  const known = deps.some((d) => ['next', 'prisma', '@prisma/client', '@nestjs/core'].includes(d)) || envKeys.some((k) => /DATABASE_URL/.test(k));
  const stackSkill = known ? 'stack-nextjs-prisma' : (!app || !app.test ? 'stack-unknown' : null);
  const ci = ciCommands(matchRoot);
  return {
    matchRoot,
    envelope,
    app: app ? { path: app.path, stack: app.stack || (app.packageManager ? 'node' : null), install: app.install, build: app.build, test: app.test, typecheck: app.typecheck, lint: app.lint, audit: app.audit, oneTest: app.oneTest || null } : null,
    ci,
    envKeys,
    stackSkill,
    unknownStack: !app,
    node: projects,
    other,
    nodeVersionFile: nvmrc ? fs.readFileSync(nvmrc, 'utf8').trim() : null,
    docker: names.filter((n) => /(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)Dockerfile$/.test(n)).slice(0, 10),
    envExamples: names.filter((n) => /(^|\/)\.env\.(example|sample)$|env\.example$/.test(n)).slice(0, 10),
    database: names.filter((n) => /schema\.prisma$|drizzle\.config|migrations?\/?$|\.sql$/.test(n)).slice(0, 10),
    tests: names.filter((n) => /(^|\/)(__tests__|tests?|e2e|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(n)).slice(0, 15),
    logs: names.filter((n) => /(^|\/)logs?(\/|$)|\.log$/.test(n)).slice(0, 15),
    docs: names.filter((n) => /(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS|ARCHITECTURE)[^/]*$|^docs\/[^/]+$/i.test(n)).slice(0, 15),
    challenge: names.filter((n) => /^challenge\//.test(n)).slice(0, 30),
    topLevel: files.filter((f) => !f.rel.includes('/')).map((f) => (f.dir ? `${f.rel}/` : f.rel)).slice(0, 60),
  };
}
