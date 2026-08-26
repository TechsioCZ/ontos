# Drizzle v1 Upgrade Readiness

Status: **deferred on Drizzle migration correctness**

Reviewed: 2026-08-26

Tested commit: `dd82e7e62816fc0071b7029817bade0e7495c4e1`

## Decision

OntOS remains on the coherent stable pair `drizzle-orm@0.45.2` and
`drizzle-kit@0.31.10`. Those versions are already pinned in every database owner and are the
current npm `latest` releases. Moving to `1.0.0-rc.4` would introduce a prerelease without an
application requirement, make Core's converted history emit false DDL, and leave Auth unable to
reach schema comparison until its RQBv1 declarations are migrated.

This is not a partial Drizzle upgrade. There is no newer stable Drizzle cohort to apply. The v1
work is a separate future assignment because it changes migration-history format and requires an
atomic Auth migration from OntOS's current Better Auth 1.6.23/RQBv1 integration to the Better Auth
1.7.1 Relations v2 adapter. Better Auth support is available; Drizzle RC migration correctness is
the blocker.

## Primary evidence

- The npm registry advertises `0.45.2` as `drizzle-orm`'s `latest` and `0.31.10` as
  `drizzle-kit`'s `latest`; `1.0.0-rc.4` is published under the `rc` tag:
  [drizzle-orm registry metadata](https://registry.npmjs.org/drizzle-orm) and
  [drizzle-kit registry metadata](https://registry.npmjs.org/drizzle-kit).
- Drizzle's official [v1 upgrade guide](https://orm.drizzle.team/docs/upgrade-v1) requires
  `drizzle-kit up` before adopting v1. The official
  [v0 to v1 changes](https://orm.drizzle.team/docs/v0-v1-changes) replace the journal-based
  migration layout and remove relational queries v1.
- Drizzle's official [v1.0.0-rc.4 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4)
  is marked as a prerelease.
- Better Auth `1.6.23`, the version currently used by OntOS, advertises
  `drizzle-orm@^0.45.2` and `drizzle-kit@>=0.31.4`. Its exact registry metadata is available at
  [better-auth 1.6.23](https://registry.npmjs.org/better-auth/1.6.23).
- Better Auth `1.7.1` is now npm `latest` and accepts
  `drizzle-orm@^0.45.2 || >=1.0.0-rc.1 <2.0.0` plus
  `drizzle-kit@>=0.31.4 || >=1.0.0-beta.1`:
  [better-auth 1.7.1](https://registry.npmjs.org/better-auth/1.7.1).
- `@better-auth/drizzle-adapter@1.7.1` exports the dedicated `./relations-v2` entrypoint and accepts
  the same Drizzle ORM v1 range:
  [adapter 1.7.1](https://registry.npmjs.org/@better-auth%2fdrizzle-adapter/1.7.1).
- Better Auth's [Relations v2 implementation](https://github.com/better-auth/better-auth/pull/9489)
  is merged, and the earlier
  [Drizzle v1 joins report](https://github.com/better-auth/better-auth/issues/10297) is closed.
- The Drizzle tracker has an open report for the same PostgreSQL upgrade path:
  [drizzle-kit up followed by a false migration](https://github.com/drizzle-team/drizzle-orm/issues/6020).
  OntOS independently reproduces this class of defect below.

## OntOS owners affected

The upgrade must remain atomic across all three independent owners:

| Owner      | Typed schema                                 | Migration history                    | Current inventory | Additional v1 concern                                                                                                                |
| ---------- | -------------------------------------------- | ------------------------------------ | ----------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| Core       | `packages/core-runtime/src/db/schema.ts`     | `packages/core-runtime/drizzle/`     |         18 tables | Converted history generates false index and check-constraint rewrites.                                                               |
| Shell Auth | `apps/shell-super-app/api/auth/db/schema.ts` | `apps/shell-super-app/drizzle-auth/` |          6 tables | Four `relations(...)` declarations use RQBv1; the owner must move atomically to Better Auth 1.7.1+ and its `./relations-v2` adapter. |
| CRM        | `verticals/crm/src/db/schema.ts`             | `verticals/crm/drizzle/`             |          2 tables | Its migration history also requires the v3 folder conversion; its schema depends on Core-owned RLS helpers.                          |

The owner-specific migration journals must remain distinct:
`drizzle.__drizzle_migrations_core`, `drizzle.__drizzle_migrations_auth`, and
`drizzle.__drizzle_migrations_crm`.

## Bounded local compatibility proof

All proof commands ran in disposable copies under `app/`; no committed SQL, snapshots, journals,
or business schemas were modified. The environment was Darwin `25.6.0` on arm64, Node `v26.5.0`,
pnpm `11.17.0`, and the repository-managed `mise exec --` toolchain. No database connection or
environment file was used: the disposable configs omitted `dbCredentials`, pointed `schema` at an
unchanged source copy or owner source, and pointed `out` at a copied migration history.

The stable proof used the installed owner-local binaries and these exact commands:

```bash
mise exec -- pnpm --filter @app/core-runtime exec drizzle-kit --version
mise exec -- pnpm --filter @app/core-runtime exec drizzle-kit generate --config .drizzle-stable-proof.config.ts
mise exec -- pnpm --filter @app/shell-super-app exec drizzle-kit generate --config .drizzle-stable-proof.config.ts
mise exec -- pnpm --filter @app/crm exec drizzle-kit generate --config .drizzle-stable-proof.config.ts
```

Before those commands, the committed histories were copied exactly:

```bash
mkdir -p .drizzle-stable-proof/core .drizzle-stable-proof/auth .drizzle-stable-proof/crm
cp -R packages/core-runtime/drizzle/. .drizzle-stable-proof/core/
cp -R apps/shell-super-app/drizzle-auth/. .drizzle-stable-proof/auth/
cp -R verticals/crm/drizzle/. .drizzle-stable-proof/crm/
```

The three disposable configs had these exact paths and contents:

`packages/core-runtime/.drizzle-stable-proof.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations_core' },
  out: '../../.drizzle-stable-proof/core',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
```

`apps/shell-super-app/.drizzle-stable-proof.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations_auth' },
  out: '../../.drizzle-stable-proof/auth',
  schema: './api/auth/db/schema.ts',
  strict: true,
  verbose: true,
});
```

`verticals/crm/.drizzle-stable-proof.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  migrations: { schema: 'drizzle', table: '__drizzle_migrations_crm' },
  out: '../../.drizzle-stable-proof/crm',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
});
```

The version command and all three generation commands exited `0`.

With the installed stable pair:

```text
drizzle-kit: v0.31.10
drizzle-orm: v0.45.2

Core:       18 tables — No schema changes, nothing to migrate
Shell Auth:  6 tables — No schema changes, nothing to migrate
CRM:         2 tables — No schema changes, nothing to migrate
```

The stable cohort also passed these exact acceptance commands from `app/`:

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @app/core-runtime exec node --test tests/unit/schema-contract.test.ts
mise exec -- pnpm --filter @app/shell-super-app exec rstest run tests/unit/auth-schema.test.ts tests/unit/auth-contract.test.ts
mise exec -- pnpm --filter @app/crm exec node --test tests/unit/schema-contract.test.ts tests/unit/database-client.test.ts tests/unit/customer-contact-persistence.service.test.ts
mise exec -- pnpm check
git diff --check
```

The frozen install and supply-chain policy exited `0`; Core passed 5/5 tests, Auth passed 14/14,
and CRM passed 13/13. The full application check exited `0`, including formatting, lint, 58 Action
unit tests, TypeScript, installed skills, i18n/API/database/module boundaries, module contracts,
workspace validation, and performance readiness. `git diff --check` also exited `0`.

The RC proof installed exactly `drizzle-orm@1.0.0-rc.4` and `drizzle-kit@1.0.0-rc.4` in an isolated
non-workspace package. Its `app/.drizzle-rc-proof/package.json` was:

```json
{
  "name": "drizzle-rc-proof",
  "private": true,
  "type": "module",
  "dependencies": {
    "drizzle-kit": "1.0.0-rc.4",
    "drizzle-orm": "1.0.0-rc.4"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

The proof copied the histories and unchanged schema sources from `app/`:

```bash
mkdir -p .drizzle-rc-proof/core .drizzle-rc-proof/auth .drizzle-rc-proof/crm
cp -R packages/core-runtime/drizzle/. .drizzle-rc-proof/core/
cp -R apps/shell-super-app/drizzle-auth/. .drizzle-rc-proof/auth/
cp -R verticals/crm/drizzle/. .drizzle-rc-proof/crm/
cp packages/core-runtime/src/db/schema.ts .drizzle-rc-proof/core-schema.ts
cp apps/shell-super-app/api/auth/db/schema.ts .drizzle-rc-proof/auth-schema.ts
```

The exact config paths were `app/.drizzle-rc-proof/core.config.ts`,
`app/.drizzle-rc-proof/auth.config.ts`, and `app/.drizzle-rc-proof/crm.config.ts`. Each began with
`import { defineConfig } from 'drizzle-kit';` and otherwise contained exactly:

```ts
// core.config.ts
export default defineConfig({
  dialect: 'postgresql',
  out: './core',
  schema: './core-schema.ts',
});

// auth.config.ts
export default defineConfig({
  dialect: 'postgresql',
  out: './auth',
  schema: './auth-schema.ts',
});

// crm.config.ts — `up` converts history without loading this placeholder schema.
export default defineConfig({
  dialect: 'postgresql',
  out: './crm',
  schema: './unused-schema.ts',
});
```

`app/.drizzle-rc-proof/unused-schema.ts` contained only `export {};`. From
`app/.drizzle-rc-proof`, the isolated install and integrity proof is:

```bash
mise exec -- pnpm install --ignore-workspace --no-frozen-lockfile
mise exec -- pnpm exec drizzle-kit --version
test "$(npm view drizzle-orm@1.0.0-rc.4 dist.integrity)" = "sha512-BT+pf+qoiYHqltoA88Jmf6ilGMXPlpfE0hEJKc2adRtMCAl25Swk/t5gXcWxZNAwdtf3F5gCd2FpeOyP/pT0Hw=="
test "$(npm view drizzle-kit@1.0.0-rc.4 dist.integrity)" = "sha512-KZCpjRyu+oYHLj/UJogfFlOkWhHVkaEI2EOT1U3NDVXUzLoTyPjqwFxwOrlQxsY6jzRyxcz4EacqboGfhEeYrA=="
rg -F "sha512-BT+pf+qoiYHqltoA88Jmf6ilGMXPlpfE0hEJKc2adRtMCAl25Swk/t5gXcWxZNAwdtf3F5gCd2FpeOyP/pT0Hw==" pnpm-lock.yaml
rg -F "sha512-KZCpjRyu+oYHLj/UJogfFlOkWhHVkaEI2EOT1U3NDVXUzLoTyPjqwFxwOrlQxsY6jzRyxcz4EacqboGfhEeYrA==" pnpm-lock.yaml
```

`drizzle-kit --version` must print both `drizzle-kit: v1.0.0-rc.4` and
`drizzle-orm: v1.0.0-rc.4`; the install, version check, and four integrity checks must exit `0`.
The conversion and generation then used these exact commands:

```bash
mise exec -- pnpm exec drizzle-kit up --config core.config.ts
mise exec -- pnpm exec drizzle-kit up --config auth.config.ts
mise exec -- pnpm exec drizzle-kit up --config crm.config.ts
mise exec -- pnpm exec drizzle-kit generate --config core.config.ts
mise exec -- pnpm exec drizzle-kit generate --config auth.config.ts
```

All three `up` commands exited `0`. Core generation exited `0`; Auth generation exited `1`.

The v1 RC converter successfully rewrote disposable copies of the existing histories into eight
Core, five Auth, and two CRM migration folders. Immediately generating from the unchanged Core
schema then created a new migration containing 39 unnecessary DDL statements:

- four partial-index drops;
- four equivalent partial-index recreations; and
- 31 equivalent check-constraint rewrites.

Generating the unchanged Auth schema with `drizzle-orm@1.0.0-rc.4` failed before comparison:

```text
Error  (0 , _drizzleOrm.relations) is not a function
```

That failure corresponds to the four owner-authored RQBv1 relation declarations. Replacing them
while retaining Better Auth 1.6.23 would be an incomplete cohort migration. Better Auth 1.7.1 now
provides the supported `./relations-v2` adapter path, so the future assignment must upgrade and test
the Auth cohort atomically rather than adding an application shim.

### Reproducible artifact checksums

The history hashes below are SHA-256 hashes of a sorted manifest containing each relative path and
that file's SHA-256. They can be recomputed from a proof directory containing `core`, `auth`, and
`crm` with:

```bash
for owner in core auth crm; do
  find "$owner" -type f -print | LC_ALL=C sort | while IFS= read -r artifact; do
    artifact_hash=$(shasum -a 256 "$artifact" | cut -d ' ' -f 1)
    printf '%s  %s\n' "$artifact_hash" "$artifact"
  done | shasum -a 256
done
```

| Owner      | v0 history                                                         | Files | Converted v1 history                                               | Files |
| ---------- | ------------------------------------------------------------------ | ----: | ------------------------------------------------------------------ | ----: |
| Core       | `2665b1f7b335bf836cfb718f2ea12a78020b56ca2768348594cbbde0bffe6862` |    17 | `53e1b851aa70bdc4e8e3f4beba87549693eb1bf1688196cb99258c2855a1e700` |    16 |
| Shell Auth | `9654be310e427d8f2667e4fbe64f92bc3af07c4d887d5758dbfbf7bdab5138e7` |    11 | `9d69aa7c6a69d3dcf1e6953dc85eaaea91650020c7ad6f4d31ad43e046ba4be3` |    10 |
| CRM        | `2594f7da21e1dd1ee4d3aea827ef376e26cef500d8e92c0680af9a7f57b5ff95` |     5 | `66dab322d84ee6f458d3084d94e7102913e3451649a7549b17995c0453e6813e` |     4 |

The false Core migration's SQL content hash is
`8a7ec03f04bdb4fbc60eb150815d205447c3ac8d7025d8192147934f15c097f2`. Its generated folder name
contains the run timestamp and is intentionally excluded from this content hash. The file has 38
physical lines and 39 DDL statements: four `DROP INDEX`, four `CREATE INDEX`, and 31 `ALTER TABLE`
constraint rewrites.

## Production-shaped migration proof

For this upgrade, a production-shaped database is an isolated PostgreSQL clone with the same major
version and required extensions, the admin and runtime roles, the exact `core`, `auth`, `crm`, and
`drizzle` schemas, representative rows satisfying every foreign key/check/RLS path, and copies of
all applied rows from the three owner-specific migration journals. It must not contain production
credentials or unrelated customer data.

The migration proof must preserve these identities:

- exactly eight Core, five Auth, and two CRM applied historical migrations;
- the SQL content hash and unambiguous v1 folder-name mapping for every historical row;
- no missing, duplicated, collided, reordered, or replayed migration;
- unchanged journal ownership through `__drizzle_migrations_core`,
  `__drizzle_migrations_auth`, and `__drizzle_migrations_crm`; and
- an idempotent second migration run with no schema or bookkeeping changes.

## Re-entry conditions

Open a dedicated Drizzle v1 assignment only when all of these are true:

1. Drizzle v1 is stable, or a concrete product dependency requires a reviewed prerelease cohort.
2. `drizzle-kit up` followed immediately by `drizzle-kit generate` produces no migration for each
   unchanged OntOS owner history.
3. The Auth dependency set can move atomically to Better Auth `1.7.1` or newer, its matching
   `@better-auth/drizzle-adapter`, and the adapter's `./relations-v2` entrypoint.
4. The Auth schema can move from `relations(...)` to `defineRelations(...)` without changing the
   physical Auth schema or weakening session, account, API-key, or impersonation behavior.
5. A clone of the production-shaped database proves the migration-bookkeeping upgrade preserves
   all applied migration identities for each owner-specific journal.
6. Core, Auth, and CRM database tests, TypeScript checks, schema inventories, migration idempotency,
   and a complete application check pass as one coherent cohort.

## Future assignment scope

When the re-entry conditions are met, the upgrade assignment should:

1. update `drizzle-orm` and `drizzle-kit` together in all three package manifests;
2. atomically update the Shell's `better-auth`, `auth`, `@better-auth/api-key`, and direct
   `@better-auth/drizzle-adapter` dependencies to one coherent `1.7.1`-or-newer cohort, then
   regenerate `pnpm-lock.yaml` with pnpm;
3. run the official converter over every owner history and review every generated folder;
4. change `apps/shell-super-app/api/auth/db/schema.ts` from `relations` to `defineRelations`, then
   move all four `drizzleAdapter` imports to `@better-auth/drizzle-adapter/relations-v2` in
   `api/auth/service.ts`, `api/auth/api-key-service.ts`, `api/auth/impersonation-service.ts`, and
   `tests/e2e/auth-fixture.ts`;
5. validate Better Auth session, account, API-key, and impersonation creation, lookup, mutation,
   revocation, and cleanup behavior through the Relations v2 adapter;
6. require a zero-DDL generation result for unchanged schemas before accepting the converted
   history; and
7. validate migration application and rerun against a production-shaped database copy before
   merge.

Run the final proof from the repository's `app/` directory. Start that assignment from a clean
worktree:

```bash
cd app
test -z "$(git -C .. status --short --untracked-files=all -- app)"
```

After staging only the intentional dependency, schema, and converted-history changes, run the
owner commands below. Each must print `No schema changes, nothing to migrate`, exit `0`, leave no
unstaged history diff, and create no untracked migration folder:

```bash
mise exec -- pnpm --filter @app/core-runtime db:generate
mise exec -- pnpm --filter @app/shell-super-app db:generate
mise exec -- pnpm --filter @app/crm db:generate
git -C .. diff --exit-code -- app/packages/core-runtime/drizzle app/apps/shell-super-app/drizzle-auth app/verticals/crm/drizzle
test -z "$(git -C .. ls-files --others --exclude-standard -- app/packages/core-runtime/drizzle app/apps/shell-super-app/drizzle-auth app/verticals/crm/drizzle)"
```

Do not resolve the future assignment with package-manager peer overrides, copied adapter code,
manual migration rewrites, relation shims, or configuration suppressions.
