import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, ensureRepoMap } from '../team-sdlc-pack/src/repo-map.mjs';
import { RuntimeSession } from '../team-sdlc-pack/src/runtime-session.mjs';
import { writeItemBrief } from '../team-sdlc-pack/src/item-brief.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit3-map-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', root], { windowsHide: true });
  const matchRoot = path.join(root, 'assigned'); fs.mkdirSync(matchRoot);
  const write = (name, value) => { const full = path.join(matchRoot, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, matchRoot, write };
}

test('recon returns an ignored preparation map with routes, procedures, relations, tests and design records', t => {
  const f = fixture(t);
  f.write('src/package.json', { scripts: { build: 'next build', test: 'vitest run', typecheck: 'tsc --noEmit' }, dependencies: { next: '1', prisma: '1' } });
  f.write('src/app/(main)/shelves/[id]/page.tsx', 'export default function Shelf() {}');
  f.write('src/app/api/shelves/route.ts', 'export async function GET() {}');
  f.write('src/server/api/routers/shelves.ts', 'export const shelvesRouter = createTRPCRouter({\n list: publicProcedure.query(() => []),\n add: protectedProcedure.input(schema).mutation(() => 1)\n});');
  f.write('src/server/services/shelf.ts', 'export async function findShelf() {}\nexport const saveShelf = async () => {};');
  f.write('src/prisma/schema.prisma', 'model Shelf {\n id Int @id\n books Book[]\n}\nmodel Book {\n id Int @id\n shelfId Int\n shelf Shelf @relation(fields: [shelfId], references: [id], onDelete: Restrict)\n}');
  f.write('src/tests/shelf.test.ts', "describe('shelf access', () => {\n  it('nested label', () => {});\n});\nit('handles empty shelves', () => {});");
  f.write('DECISIONS.md', 'Synthetic rules'); f.write('src/specs/shelves.md', 'Invented'); f.write('README.md', 'Synthetic README');
  f.write('node_modules/hidden.ts', 'export const NeverInclude = 1;');
  fs.mkdirSync(path.join(f.root, 'unassigned')); fs.writeFileSync(path.join(f.root, 'unassigned', 'foreign.ts'), 'export const OtherFolder = 1;');
  const s = new RuntimeSession({ teamWorkspace: f.root }); s.checkoutRoot = f.root; s.matchRoot = f.matchRoot; s.repository = { folder: 'assigned' };
  const result = s.recon_repo();
  assert.equal(result.ok, true);
  assert.equal(result.repoMapPath, path.join(f.root, '.mtm-notes', 'repo-map.md'));
  const text = fs.readFileSync(result.repoMapPath, 'utf8');
  for (const value of ['app root: src', 'npm install', 'npm run build', 'npm test', 'npm run typecheck', 'page.tsx -> /shelves/[id]', 'route.ts -> /api/shelves', 'shelves.ts: list, add', 'findShelf, saveShelf', 'books Book[]', 'onDelete: Restrict', 'shelf access; handles empty shelves', 'DECISIONS.md', 'src/specs/shelves.md', 'README.md']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /NeverInclude|OtherFolder|nested label/);
  assert.ok(text.split('\n').length <= 400);
  assert.match(execFileSync('git', ['-C', f.root, 'check-ignore', result.repoMapPath], { encoding: 'utf8', windowsHide: true }), /repo-map.md/);
  f.write('src/app/later/page.tsx', 'export default function Later() {}');
  assert.equal(fs.readFileSync(s.recon_repo().repoMapPath, 'utf8'), text, 'snapshot is generated once');
  const brief = writeItemBrief({ checkoutRoot: f.root, matchRoot: f.matchRoot, item: { id: 'TASK-91' }, material: { files: {} } });
  assert.ok(brief.repoMapPath.startsWith(f.matchRoot + path.sep));
  assert.equal(fs.readFileSync(brief.repoMapPath, 'utf8'), text);
});

test('unknown stacks, malformed files and large projects retain bounded generic localization', t => {
  const f = fixture(t);
  f.write('package.json', '{broken'); f.write('schema.prisma', 'model Broken {');
  f.write('lib/main.ts', 'export function locate() {}');
  for (let i = 0; i < 450; i++) f.write(`lib/unit${i}.ts`, `export const value${i} = 1;`);
  const text = buildRepoMap(f.matchRoot);
  assert.match(text, /lib\/: 451/); assert.match(text, /main.ts: locate/);
  assert.ok(text.split('\n').length <= 400);
  assert.match(text, /more entries omitted/);
  assert.doesNotThrow(() => buildRepoMap(path.join(f.root, 'missing')));
});

test('repo map never follows out-of-scope links and reports write failures without throwing', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'other'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'foreign.ts'), 'export function PrivateSymbol() {}');
  fs.symlinkSync(outside, path.join(f.matchRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotMatch(buildRepoMap(f.matchRoot), /PrivateSymbol|foreign.ts/);
  fs.writeFileSync(path.join(f.root, '.mtm-notes'), 'cannot create a directory here');
  const result = ensureRepoMap({ checkoutRoot: f.root, matchRoot: f.matchRoot });
  assert.equal(result.repoMapPath, null); assert.match(result.repoMapWarning, /unavailable/);
});
