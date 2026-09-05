# Drizzle v1 Upgrade

Status: **applied**

Cohort: `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@1.0.0-rc.4`, `better-auth@1.7.2`,
`@better-auth/api-key@1.7.2`, `@better-auth/drizzle-adapter@1.7.2`, `auth@1.7.2`

This document records how OntOS moved from the stable `0.45.2`/`0.31.10` pair to the Drizzle v1
release candidate, which repository surfaces changed, how the three migration histories were
converted without touching any applied migration, and which proofs gate a future Drizzle bump.
[Database Architecture](./DATABASE.md) remains the authoritative rule set; this page is the
upgrade record and operator runbook.

## Decision

OntOS deliberately tracks the Drizzle `rc` channel instead of waiting for `1.0.0` stable. The
readiness analysis that preceded this upgrade (pull request `TechsioCZ/ontos#98`) deferred the move
because `drizzle-kit up` produced a false migration for unchanged owners and because the Auth owner
still used Relational Queries v1. Both blockers are resolved here:

- the false migration is a documented converter defect
  ([drizzle-team/drizzle-orm#6020](https://github.com/drizzle-team/drizzle-orm/issues/6020)) that
  is corrected once, deterministically, by normalizing SQL fragments in the converted snapshots;
- Better Auth `1.7.2` ships the `@better-auth/drizzle-adapter/relations-v2` entrypoint, so the Auth
  owner moves to `defineRelations` with the officially supported adapter.

The hash-suffixed `rc5` snapshot builds on npm (`1.0.0-rc.5-*`) are branch builds, not a tagged
release, and were not adopted. Bump to `1.0.0-rc.5` or `1.0.0` only through the proof sequence in
[Re-proof checklist](#re-proof-checklist).

## What changed

### Dependencies

| Package                        | Before   | After        | Owners                                   |
| ------------------------------ | -------- | ------------ | ---------------------------------------- |
| `drizzle-orm`                  | 0.45.2   | 1.0.0-rc.4   | root, `core-runtime`, Shell, `contacts`  |
| `drizzle-kit`                  | 0.31.10  | 1.0.0-rc.4   | `core-runtime`, Shell, `contacts`        |
| `better-auth`                  | 1.6.23   | 1.7.2        | root, Shell                              |
| `@better-auth/api-key`         | 1.6.23   | 1.7.2        | Shell                                    |
| `@better-auth/drizzle-adapter` | indirect | 1.7.2 direct | root, Shell (`/relations-v2` entrypoint) |
| `auth` (Better Auth CLI)       | 1.6.23   | 1.7.2        | Shell                                    |

Every owner pins the identical Drizzle pair. `pnpm-lock.yaml` contains no `0.45.2`, `0.31.10`, or
`1.6.23` entries; the workspace `minimumReleaseAge` policy (24 hours) is satisfied by all of them.

### Migration folder layout (v3)

Each owner history is now one folder per migration instead of numbered SQL files plus
`meta/_journal.json`:

```text
packages/core-runtime/drizzle/
  20260729125026_dashing_ghost_rider/
    migration.sql
    snapshot.json
  ...
  20260901102632_<latest tag>/
```

Folder names are `<14-digit UTC timestamp>_<tag>`; the timestamp is the old journal `when`
value. `drizzle-kit up` produced every folder, and each `migration.sql` is byte-identical to the SQL
file it replaced (verified with `cmp` against `git show HEAD:<old path>` for all 20 files across
Core, Auth, and Contacts). Snapshots are DDL snapshots (`version: 8`) with an `id`/`prevIds` chain
that `drizzle-kit check` and `generate` use to detect non-commutative migrations across branches.

Repository surfaces that referenced the old layout were updated:

- `verticals/contacts/tests/unit/schema-contract.test.ts` reads `<folder>/migration.sql`;
- `packages/core-runtime/tests/integration/contacts-identity-migration.test.ts` reads the renamed
  Core migration folder;
- `scripts/validate-ultramodern-workspace.mts` allowlists the historical migration files that still
  carry the pre-rename module identity.

### Snapshot normalization after `drizzle-kit up`

`drizzle-kit up` copies SQL fragments from the v0 snapshots verbatim. The v1 schema reader renders
partial-index predicates and check-constraint expressions without the `"schema"."table".`
qualifier, so an unchanged schema diffs as changed. On OntOS this produced 39 false DDL statements
for Core (4 partial-index rebuilds, 31 check-constraint rewrites) and 12 for Contacts.

The converted snapshots were normalized once with the script below, after `up` and before the first
`generate`. It strips only the entity's own `"<schema>"."<table>".` prefix from index `where`
predicates, check `value` expressions, and expression index columns. Row-level-security policy
predicates are intentionally left alone: the v1 reader keeps them qualified, and stripping them
reintroduces a false `ALTER POLICY` migration.

```js
// normalize-v1-snapshots.mjs — run once per owner history after `drizzle-kit up`
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const roots = process.argv.slice(2);
let files = 0;
let fragments = 0;
const fields = { indexes: ['where'], checks: ['value'] };
for (const root of roots) {
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, 'snapshot.json');
    try {
      statSync(file);
    } catch {
      continue;
    }
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    let touched = false;
    for (const entity of snapshot.ddl) {
      const qualifier = `"${entity.schema}"."${entity.table}".`;
      const strip = (text) => text.split(qualifier).join('');
      for (const field of fields[entity.entityType] ?? []) {
        if (typeof entity[field] === 'string' && entity[field].includes(qualifier)) {
          entity[field] = strip(entity[field]);
          fragments++;
          touched = true;
        }
      }
      if (entity.entityType === 'indexes') {
        for (const column of entity.columns) {
          if (column.isExpression && column.value.includes(qualifier)) {
            column.value = strip(column.value);
            fragments++;
            touched = true;
          }
        }
      }
    }
    if (touched) {
      writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      files++;
    }
  }
}
console.log(`normalized ${fragments} fragments in ${files} snapshots`);
```

Result on this repository: `normalized 333 fragments in 13 snapshots`. After normalization every
owner's `db:generate` prints `No schema changes, nothing to migrate`. Snapshots are metadata for
diffing; the normalization changes no SQL and no database object.

### Typed schema and runtime code

- **Relational Queries v2.** `apps/shell-super-app/api/auth/db/schema.ts` replaces the four
  `relations(...)` declarations with one `authRelations = defineRelations(authDatabaseSchema, ...)`
  graph (`user.sessions`, `user.accounts`, `user.apiKeys`, and the `one` reverse edges). Core and
  Contacts export `coreRelations` / `contactsRelations` as `defineRelations(<tables>)` with no
  navigational relations yet, which still exposes typed `db.query.<table>` access.
- **Executor types.** `NodePgDatabase<typeof coreRelations>`, `NodePgDatabase<typeof authRelations>`,
  and `NodePgDatabase<typeof contactsRelations>` replace the schema-keyed generics. Every
  `drizzle({ client, schema })` call site now passes `relations` instead.
- **Better Auth.** All five `drizzleAdapter` imports (`service.ts`, `api-key-service.ts`,
  `impersonation-service.ts`, `stage-demo-bootstrap-runtime-infrastructure.ts`, the e2e fixture)
  and `scripts/initialize-local-development.mts` import from
  `@better-auth/drizzle-adapter/relations-v2`. The adapter still receives `schema: authDatabaseSchema`
  (tables keyed by Better Auth model name) and `transaction: true`.
- **Row-level security.** The deprecated `table.enableRLS()` wrapper `enableGovernedRls` was removed
  from `@app/core-runtime`; Contacts tables are declared with `contactsSchema.table.withRLS(...)`.
  `tenantRlsPolicies` and `tenantLegalEntityRlsPolicies` are unchanged.
- **Deprecated helpers.** `getTableColumns` became `getColumns`; the Core schema-contract test asserts
  the sequence column through `getSQLType()` because v1 reports `dataType` as `bigint int64`.

### Better Auth 1.7 account identity

Better Auth 1.7 keys every provider identity on `(issuer, accountId)` and requires a non-null
`account.issuer` column with a unique index over both columns. The Auth owner adds that column in
`20260905002342_add-account-issuer`. The migration is expand-then-tighten inside one transaction:

1. add `issuer` as nullable;
2. refuse to continue if any `provider_id` needs URI encoding (OntOS only has `credential`);
3. backfill `local:credential` for credential accounts and `local:oauth:<providerId>` otherwise,
   which is Better Auth's `provider-id` identity strategy;
4. refuse to continue if two rows share an `(issuer, account_id)` identity;
5. set `NOT NULL` and create `auth_account_issuer_account_id_uk`.

Better Auth 1.6 writers do not supply `issuer`, so the migration also installs a `BEFORE INSERT`
trigger (`auth.account_issuer_compat`) that derives the value with the same rule when a row arrives
without one. That keeps the previous Shell release working against the expanded schema, as the
[Deployment](./DEPLOYMENT.md) sequence requires, so the Auth migration stays expand-only. Drop the
trigger and its function in a later contraction migration once no Better Auth 1.6 writer remains;
Better Auth 1.7 always writes `issuer` explicitly, so the trigger is inert for the new release.

### New `db:check` script

`pnpm db:check` runs `drizzle-kit check` for Core, Auth, and Contacts. It validates the snapshot
chain and reports non-commutative migrations when two branches both add migrations. Run it after
rebasing a branch that touches any `drizzle/` or `drizzle-auth/` folder.

## Migration bookkeeping upgrade

The first `drizzle-kit migrate` with v1 against an existing database upgrades each owner's
bookkeeping table in `drizzle` (`__drizzle_migrations_core`, `__drizzle_migrations_auth`,
`__drizzle_migrations_contacts`):

- adds `name text` and backfills it with the v3 folder name matched by `created_at` millis;
- adds `applied_at timestamptz default now()`; pre-upgrade rows keep `applied_at = NULL`;
- keeps `id`, `hash`, and `created_at` unchanged.

The v1 migrator applies every migration folder missing from the table, not only folders newer than
the last applied row. This requires the administrative identity that already runs
`pnpm db:migrate`; no manual SQL is needed.

## Proofs

Environment: Darwin arm64, Node `26.5.0` and pnpm `11.25.0` through `mise exec --`, PostgreSQL 17
in the local Compose container on port 5433.

| Proof                                                    | Result                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `drizzle-kit up` for Core, Auth, Contacts                | 9 + 6 + 4 folders; every `migration.sql` byte-identical to its predecessor         |
| Auth `add-account-issuer` on the populated copy          | exit 0, one credential row backfilled to `local:credential`, unique index present  |
| `db:generate` for each owner after normalization         | `No schema changes, nothing to migrate` for all three                              |
| `db:check` for each owner                                | `Everything's fine`                                                                |
| `db:migrate` on a `TEMPLATE ontos` copy with v0 journals | exit 0, 9/7/4 rows, `name` backfilled, catalog column hash identical after a rerun |
| `db:migrate` on an empty database                        | exit 0, 9/7/4 rows, schemas `core`/`auth`/`contacts`/`drizzle` present             |
| `db:verify` on both databases                            | exact schemas, journals, and 18/6/3 typed tables verified                          |
| `pnpm typecheck`, `pnpm lint`                            | clean                                                                              |
| `pnpm action:test:unit`, `pnpm outbox:test`              | 64/64 and all outbox tests passing                                                 |
| `pnpm db:test` (Core, Auth integration, Contacts)        | see the pull request for the final run                                             |

## Re-proof checklist

Use this sequence for `1.0.0-rc.5`, `1.0.0`, or any later Drizzle bump:

1. Bump `drizzle-orm` and `drizzle-kit` together in the root, Core, Shell, and Contacts manifests,
   plus the Better Auth cohort when its Drizzle peer range moves; run
   `mise exec -- pnpm install --no-frozen-lockfile`.
2. Run `pnpm db:generate` and `pnpm db:check`; both must report no changes for unchanged schemas.
   A generated folder for an unchanged owner is a converter or reader regression, not a schema
   change, and must not be committed.
3. Create a disposable copy of a migrated database (`create database <name> template ontos`),
   point `DATABASE_ADMIN_URL`/`DATABASE_URL` at it, and run `pnpm db:migrate` twice followed by
   `pnpm db:verify`. Row counts per owner must not change and the second run must be a no-op.
4. Run `pnpm db:migrate` and `pnpm db:verify` against an empty database.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm db:test`, `pnpm action:test:unit`, `pnpm outbox:test`,
   and `pnpm check`.

## Next step: Effect-native driver

`drizzle-orm@1.0.0-rc.4` ships `drizzle-orm/effect-postgres` on top of `@effect/sql-pg`
(peer `effect >= 4.0.0-beta.83`, satisfied by the workspace `4.0.0-beta.107`). Its queries are
`Effect` values and `db.transaction` has the signature
`(tx) => Effect<A, E, R>` returning `Effect<A, E | SqlError, R>`, which removes the Promise
boundary that the [Effect v4 anti-pattern audit](./EFFECT_V4_ANTIPATTERN_AUDIT.md) identifies in
the Action and Read runtimes. Adopting it is a separate assignment: it replaces the `pg.Pool`
ownership in every owner `db/client.ts`, changes `CoreDbExecutor`/`CoreTransaction` from Promise
executors to Effect executors, and touches every repository. This upgrade keeps
`drizzle-orm/node-postgres` so that the Drizzle cohort and the executor model do not change in the
same release.
