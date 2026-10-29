---
name: stack-nextjs-prisma
description: Stack notes for an MTM match whose customer system is a Next.js (App Router) + tRPC + Prisma + PostgreSQL app tested with vitest - commands, where things live, DB changes, tests and evidence. Read once after recon_repo reports stackSkill stack-nextjs-prisma.
---

# Stack: Next.js + tRPC + Prisma + PostgreSQL (vitest)

App root is `<matchRoot>/<app.path>` (usually `src/`). Run every command from there. `recon_repo` gives the exact commands; the usual ones with pnpm:
`pnpm install --frozen-lockfile` · `pnpm test` (vitest) · `pnpm typecheck` · `pnpm build` · `pnpm exec prisma migrate deploy` · `pnpm db:seed` · `pnpm exec prisma migrate dev --name <slug>`

## Where things live (typical layout)
- `src/app/**` — routes and pages (App Router). `src/app/(app)/...` authed pages, `src/app/api/**` route handlers.
- `src/server/api/routers/*.ts` — tRPC routers (the real API). `src/server/services/*` — business logic. `src/server/db.ts` — Prisma client, `src/server/auth.ts` — NextAuth.
- `src/schemas/*.ts` — zod input schemas (validation lives here; API errors come from them).
- `src/components/**` — UI. `src/lib/*` — helpers (money in minor units, positions, dates).
- `prisma/schema/*.prisma` (multi-file) + `prisma/migrations/**`; `prisma/seed.ts`.
- `tests/*.test.ts` + `tests/helpers.ts` (`truncateAll`, fixtures) + `tests/global-setup.ts` (creates the test DB).

## Finding the code for an item
Search the user-visible string first (label, error code, column header, route segment): `rg -n "<text>" src prisma`. From a page, follow the tRPC procedure name to `server/api/routers`, then to `server/services`, then to the Prisma model. A validation message usually comes from `src/schemas`.

## Database changes (CR)
1. Edit the right `prisma/schema/*.prisma` file (one module per file).
2. `pnpm exec prisma migrate dev --name <item-slug>` — creates `prisma/migrations/<timestamp>_<slug>/migration.sql`. **Commit the migration folder**: the grader clones the revision and applies migrations.
3. Never edit an existing migration; never `migrate reset` (it drops data). If a trigger/constraint is needed, add raw SQL inside the new migration.
4. Keep existing data valid: a new NOT NULL column needs a default or a backfill statement in the migration.
5. Run `pnpm exec prisma generate` if types look stale, then `pnpm typecheck`.
6. Restoring a relation/constraint rule (e.g. a red pre-existing test shows `onDelete` must be `Restrict`, not `Cascade`): change the rule in the `.prisma` schema AND ship it as a new migration, or the next `migrate dev` reverts it. Non-interactive and safe: `pnpm exec prisma migrate dev --create-only --name <slug>`, review the generated SQL (only the intended constraint), then `pnpm exec prisma migrate deploy` and run the full suite. This applies to any item, not only CRs.

## Tests (vitest)
- One file per area in `tests/`; follow `helpers.ts` (`truncateAll()` in `beforeEach`, fixture builders). Prefer service/router-level tests over UI tests: they are what the grader can run.
- Run one file: `pnpm test tests/<file>.test.ts`; one case: `pnpm test -t "<name>"`.
- `TEST_DATABASE_URL` must be unique per working copy (the suite truncates between cases). In a worktree the helper rewrites it; never point tests at `DATABASE_URL`.
- `fileParallelism: false` is intentional — do not "optimize" it away.
- UI-only change with no sensible unit test: assert the component/HTML (render or a route handler response) and add a screenshot as evidence (`pnpm exec playwright` is available as a dev dependency when the repo has it; otherwise a headless Chrome/Edge binary that exists on this machine, with `--screenshot` (see evidence-and-answer)).

## Money, dates, ordering (common traps)
- Money is stored in **minor units (BIGINT)**; convert at the form/transport boundary (`src/lib/money.ts`), zero-decimal currencies use factor 1. Never do float math on totals.
- Accounting ledger is append-only (DB triggers): corrections are reversing entries, never UPDATE/DELETE of journal rows.
- Card/list order uses fractional positions (midpoint of neighbours); use the existing helper, do not renumber everything.
- Timestamps are `timestamptz`; day bucketing uses the settings timezone, not the server's.

## Before submitting
`pnpm typecheck` + `pnpm build` + the affected test files (and the full suite once if it is under ~3 minutes). Evidence: command + summary counts per MVS scenario; for UI, a screenshot. Never commit `.env`, `node_modules`, `data/uploads` or a changed `exam-info.json`.
