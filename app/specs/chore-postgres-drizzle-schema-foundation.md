---
type: chore
status: done
created: 2026-07-29
---

# Chore: PostgreSQL and Typed Drizzle Schema Foundation

## Chore Description

Establish the local PostgreSQL and typed Drizzle foundation for the OntOS
application on `develop`, using the read-only MVP2 experiment at
`/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2` as the
schema reference.

Add a root Compose project named `ontos` with a PostgreSQL 17 Alpine service
and container named `ontos-db`, a persistent named volume, a health check, and
an `ontos` database. Add a committed root `.env.example` containing the local
connection values and keep the developer's `.env` untracked. Configure both
Drizzle Kit and the Effect-managed application database service to load and
validate `DATABASE_URL` from that root environment.

Install Drizzle ORM with the `pg`/node-postgres driver and Drizzle Kit in the
package that owns the Core database infrastructure. Promote only the 18 MVP2
tables defined in the existing PostgreSQL schema named exactly `core`.
Explicitly exclude the `auth` schema and every MicroVertical or business
schema, including `ticketing`, `properties`, `property`, `accounting`, and any
future vertical schema. Preserve the applicable Core tables, columns,
constraints, and indexes while correcting experiment-era definitions that
conflict with the current authoritative Action lifecycle. Generate a fresh
Core-only migration history instead of copying MVP2's historical migrations,
apply it to the new local database, verify the resulting schema through typed
Drizzle access, and prove that rerunning the migration is a no-op.

Document an authoritative application rule that SQL access uses typed Drizzle
schema objects and query builders together with Effect. Handwritten SQL
strings, direct driver queries, and string-concatenated SQL are prohibited
when Drizzle can express the operation. Drizzle's parameterized `sql` tagged
template is reserved for schema constraints, bootstrap/migration work, or a
narrowly documented database operation that Drizzle cannot otherwise express.

## Relevant Files

Use these files to accomplish the chore:

- `../AGENTS.md` — repository scope, read-only MVP folders, and mandatory
  generator rules.
- `AGENTS.md` — authoritative application architecture and managed pnpm
  command convention.
- `README.md` — current shell-only workspace shape and strict Effect topology.
- `docs/architecture/MICROVERTICALS.md` — independently deployable vertical
  seams that this Core-only chore must not cross.
- `docs/architecture/ACTIONS.md` — authoritative pre-authentication Action
  Invocation Log and indeterminate-outcome requirements that supersede the
  MVP2 experiment schema.
- `docs/architecture/ERRORS.md` — typed Effect error requirements for
  expected configuration and database failures.
- `docs/architecture/ULTRAMODERN.md` — infrastructure-file exception and
  prohibition on manually creating unsupported business file types.
- `../docs/06_CORE_KERNEL.md` — Core-owned database capabilities and the
  boundary against vertical business data.
- `../docs/10_DATA_STORAGE_AND_PROJECTIONS.md` — PostgreSQL schema ownership,
  Drizzle-plus-Effect requirement, and narrow raw-SQL exception.
- `../docs/adr/0002-modular-monolith-for-v0.md` — current V0 modular-monolith
  deployment context.
- `../docs/adr/0004-postgres-canonical-neo4j-projection.md` — PostgreSQL as the
  canonical operational store.
- `package.json` — workspace database orchestration scripts and final
  validation aggregate.
- `pnpm-workspace.yaml` — dependency policy and Effect cohort that new
  database dependencies must respect.
- `tsconfig.json` — project references for the new Core infrastructure
  package.
- `.gitignore` — protection for the developer's root `.env`.
- `scripts/validate-ultramodern-workspace.mts` — generated workspace contract
  that must continue to recognize every package and topology owner.
- `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2/docker-compose.yml`
  — read-only PostgreSQL 17, local port, volume, and health-check reference.
- `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2/.env` —
  read-only reference for variable names only; do not copy secret values.
- `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2/packages/core-runtime/drizzle.config.ts`
  — read-only Drizzle schema-discovery and migration reference.
- `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2/packages/core-runtime/src/db/schema.ts`
  — read-only reference for the 18 `core` tables.
- `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-main/mvp2/packages/core-runtime/drizzle/`
  — read-only evidence of the Core schema evolution; do not copy the
  experiment's mixed-schema historical migration chain into `develop`.

### New Files

- `docker-compose.yml` — local `ontos` Compose project with the `ontos-db`
  PostgreSQL service and persistent volume.
- `.env.example` — non-secret local PostgreSQL and `DATABASE_URL` values.
- `docs/architecture/DATABASE.md` — authoritative typed Drizzle, Effect,
  schema ownership, environment, and raw-SQL rules.
- `packages/core-runtime/package.json` — Core database package dependencies
  and focused schema, migration, test, and verification scripts.
- `packages/core-runtime/tsconfig.json` — TypeScript project configuration for
  Core database infrastructure.
- `packages/core-runtime/drizzle.config.ts` — PostgreSQL Drizzle Kit
  configuration that loads the root `.env`.
- `packages/core-runtime/src/db/config.ts` — validated database configuration
  and typed configuration failure.
- `packages/core-runtime/src/db/client.ts` — scoped Effect-managed `pg` pool
  and typed Drizzle client service.
- `packages/core-runtime/src/db/schema.ts` — promoted and reconciled `core`
  schema.
- `packages/core-runtime/src/db/types.ts` — inferred Drizzle executor and
  transaction types.
- `packages/core-runtime/src/index.ts` — narrow public exports for the Core
  database package.
- `packages/core-runtime/tests/config.test.ts` — environment parsing and typed
  failure tests.
- `packages/core-runtime/tests/schema-contract.test.ts` — static table,
  ownership, and critical Action lifecycle schema assertions.
- `packages/core-runtime/scripts/verify-db-schema.mts` — migration smoke check
  that reaches every promoted Core table through typed Drizzle table
  references.
- `packages/core-runtime/drizzle/*.sql` and
  `packages/core-runtime/drizzle/meta/**` — fresh generated Core-only migration
  and Drizzle metadata.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Lock the migration scope to the Core schema

- [x] Record the only in-scope MVP2 reference inventory as the 18 tables in
      PostgreSQL schema `core`
      (`tenants`, `legal_entities`, `principals`,
      `principal_auth_bindings`, `tenant_module_states`,
      `action_invocations`, `tenant_module_state_changes`, `audit_events`,
      `data_access_events`, `domain_events`, `outbox_messages`,
      `outbox_deliveries`, `outbox_attempts`, `media_assets`, `media_links`,
      `evidence_references`, `search_index_entries`, and
      `worker_checkpoints`).
- [x] Preserve the PostgreSQL schema name exactly as `core`; do not rename it,
      flatten its tables into `public`, or introduce another Core schema name.
- [x] Configure Drizzle schema discovery, migration generation, runtime
      registration, tests, and verification to import only
      `packages/core-runtime/src/db/schema.ts`.
- [x] Explicitly exclude the MVP2 `auth` schema and every MicroVertical schema.
      Do not create, migrate, test, or reference `auth`, `ticketing`,
      `properties`, `property`, `accounting`, or any other business schema.
- [x] Treat the 18-name Core inventory as an exact set: implementation fails
      if any expected Core table is missing or if any additional OntOS
      application table is present. PostgreSQL system catalogs and Drizzle's
      migration bookkeeping are infrastructure metadata, not OntOS
      application tables, and must be checked separately.
- [x] Do not run an Action, MicroVertical page, Outbox Message, Policy, or
      vertical generator because this chore creates only Core database
      infrastructure and no business module.

### 2. Make typed database access authoritative

- [x] Add `docs/architecture/DATABASE.md` and link it from the Required
      Guidance section of `AGENTS.md` as the authoritative rule for database
      work.
- [x] Require every application query and mutation to use typed Drizzle
      table/column references and query builders inside Effect services.
      Prohibit direct `pg` queries, interpolated SQL strings, untyped result
      objects, and exported promise-only database APIs when Drizzle and Effect
      can represent the behavior.
- [x] Permit Drizzle's parameterized `sql` tagged template only for typed
      checks/index predicates, migration/bootstrap work, or a documented
      operation not expressible by a Drizzle builder. Require a nearby reason
      and focused test for every application-level exception.
- [x] State that this package owns only PostgreSQL schema `core`, that `public`
      owns no OntOS application tables, and that Auth and MicroVertical
      schemas remain outside this chore and outside this migration history.

### 3. Add the local PostgreSQL Compose project and environment contract

- [x] Add a top-level `docker-compose.yml` with top-level `name: ontos` (Docker
      Compose project names must be lowercase), service key and
      `container_name: ontos-db`, image `postgres:17-alpine`, and database,
      user, password, and host-port interpolation from `.env`.
- [x] Configure `POSTGRES_DB=ontos`, a health check against the configured
      `ontos` database, restart-safe persistent storage through a named
      `ontos_postgres_data` volume, and host port `5433` so the new stack
      retains MVP2's non-default local-port convention without colliding with
      a system PostgreSQL on `5432`.
- [x] Add root `.env.example` with explicit development-only values for
      `POSTGRES_DB=ontos`, `POSTGRES_USER=ontos`,
      `POSTGRES_PASSWORD=ontos`, `POSTGRES_HOST=localhost`,
      `POSTGRES_PORT=5433`, and
      `DATABASE_URL=postgresql://ontos:ontos@localhost:5433/ontos`.
- [x] Add root `.env` to `.gitignore`, copy `.env.example` to the local
      untracked `.env` when executing the chore, and never read or copy secret
      values from the MVP2 `.env`.
- [x] Validate interpolation and service naming with `docker compose config`;
      start only `ontos-db`, wait for its health check, and prove
      `pg_isready` succeeds for database `ontos`.

### 4. Add the Core database package and PostgreSQL Drizzle toolchain

- [x] Create the infrastructure-owned `@app/core-runtime` package, add it to
      the root TypeScript project references, and adjust the generated
      workspace validator only as required to keep its package/topology
      contract accurate. Do not classify Core runtime as a business
      MicroVertical or add it to browser Module Federation exposes.
- [x] From `app/`, install repository-policy-compatible exact versions of
      `drizzle-orm`, `pg`, and the existing Effect cohort as runtime
      dependencies and `drizzle-kit`, `@types/pg`, and `dotenv` as development
      dependencies using `mise exec -- pnpm --filter @app/core-runtime ...`.
      Do not copy MVP2's old versions or introduce a second Effect cohort.
- [x] Add `drizzle.config.ts` with `dialect: "postgresql"`, the owning schema
      source paths, a package-owned `drizzle/` output, `strict: true`, and
      `verbose: true`. Load the root `.env` by an explicit path resolved from
      the package instead of depending on the command's current directory.
- [x] Add focused `db:generate`, `db:migrate`, `db:test`, and `db:verify`
      package scripts and root orchestration scripts that target only the Core
      schema owner. Ensure every pnpm invocation remains
      `mise exec -- pnpm ...`.
- [x] Implement database configuration as a validated Effect dependency.
      Missing or malformed `DATABASE_URL` must produce a declared typed
      configuration error rather than a non-null assertion, silent localhost
      fallback, thrown expected error, or untyped rejected Promise.
- [x] Implement the application connection as a scoped Effect Layer around a
      `pg.Pool` and `drizzle-orm/node-postgres`, close the pool on scope
      release, and expose the typed Drizzle executor only through the
      server-side Core infrastructure package. Do not import it into shell
      browser code.
- [x] Add tests proving root `.env` discovery is independent of the invocation
      directory, valid local configuration produces the expected connection
      settings, invalid configuration remains typed, and pool finalization
      runs when the Effect scope closes.

### 5. Promote and reconcile the Core typed schema

- [x] Promote exactly the 18 Core tables from the read-only MVP2
      `packages/core-runtime/src/db/schema.ts` source, preserving PostgreSQL
      schema name `core`, column types, defaults, foreign keys, delete
      behavior, indexes, unique constraints, and check constraints.
- [x] Reconcile `core.action_invocations` with the current
      `docs/architecture/ACTIONS.md`: allow the initial row to exist before
      authentication by making principal/authentication fields nullable until
      resolved, retain an available anonymous-session reference and transport
      correlation, and include `indeterminate` among the permitted lifecycle
      statuses. Preserve `replayed` only for the documented idempotency path.
- [x] Keep successful canonical writes, evidence records, domain events, and
      outbox data representable in the same PostgreSQL transaction while the
      Action Invocation Log remains independently persistable. Do not copy an
      MVP2 constraint when it prevents an authoritative current lifecycle.
- [x] Use Drizzle schema builders and parameterized Drizzle `sql` expressions
      for constraints and partial indexes; do not replace the typed source
      schema with handwritten migration SQL.
- [x] Add a static schema contract test that enumerates the promoted schema
      and table names and proves the critical pre-authentication principal
      nullability, status union (including `indeterminate`), foreign keys,
      and unique indexes before migration generation. Add negative assertions
      that no Auth or MicroVertical table is registered, and compare the
      exported Core table names as exact-set equality against the 18-table
      inventory so both missing and unexpected tables fail.

### 6. Generate, apply, and verify the fresh Core migration

- [x] With the final typed Core schema committed in source, run the Core
      owner's `db:generate` script and review the generated SQL and metadata.
      Generate a fresh baseline for `develop`; do not copy MVP2 migration
      names, snapshots, or incremental SQL that describe experiment history.
- [x] Assert that the generated migration creates exactly PostgreSQL schema
      `core`, its 18 expected tables and constraints, and no application tables
      in `public`. Confirm it creates no `auth`, `ticketing`, `properties`,
      `property`, `accounting`, SpiceDB, or other MVP2 service schema.
- [x] Apply the Core migration to a healthy, empty `ontos` database backed by
      the new chore-owned Compose volume using the root `.env`. Before using an
      existing volume, inspect its exact Compose project and volume identity;
      do not delete or reuse unrelated data. Capture the successful command
      result, rerun the same migration command, and prove the second execution
      succeeds without reapplying or duplicating schema objects.
- [x] Implement and run `db:verify` using imported typed Drizzle table
      references and zero-row/rollback-safe queries against all 18 Core
      tables. Do not use a handwritten `information_schema` query merely to
      avoid the typed schema.
- [x] In the same verifier, use one documented, parameterized Drizzle `sql`
      catalog query as the necessary migration-verification exception to
      compare the database's OntOS application tables with the exact 18-table
      `core` inventory. Fail with explicit missing and unexpected sets. Assert
      that `public` has no application tables and that `auth`, `ticketing`,
      `properties`, `property`, `accounting`, and every other non-Core
      application schema are absent. Exclude only PostgreSQL system objects
      and the Drizzle migration bookkeeping object from this application-table
      comparison.
- [x] Leave the local `ontos-db` service healthy and migrated for subsequent
      development. Do not remove its volume as part of normal validation.

### 7. Run every validation command

- [x] Execute every command listed under Validation Commands in order and
      resolve failures without weakening typed SQL, Effect errors, schema
      ownership, generated migration history, or existing workspace gates.
- [x] Inspect `git status --short` afterward and confirm no `.env`, database
      volume data, copied MVP2 files, unrelated login work, or generated build
      output is included in the implementation diff.

## Testing Strategy

Add unit tests for root environment discovery, valid and invalid
`DATABASE_URL` handling, typed configuration failures, scoped pool cleanup,
schema/table inventory, Action lifecycle constraints, and inferred Drizzle
types. Add database integration verification that starts from the new Compose
database, applies the generated migration history, reaches every promoted
Core table through its typed Drizzle reference, proves a second migration run
is idempotent, and compares the final application-table catalog to the exact
18-table Core inventory. Test both mismatch directions: one expected table
missing and one unexpected application table/schema present.

Generated migration SQL and Drizzle's parameterized schema-constraint
expressions are expected exceptions to the no-SQL-strings rule. Application
queries used by tests and verification must remain typed Drizzle queries.

## Acceptance Criteria

- [x] `docker compose config` resolves a project named `ontos`, a service and
      container named `ontos-db`, PostgreSQL 17 Alpine, a persistent named
      volume, and an `ontos` database health check.
- [x] The committed root `.env.example` contains usable non-secret local
      values, the untracked root `.env` is ignored, and both Docker Compose and
      application tooling use the same connection contract.
- [x] `@app/core-runtime` uses `drizzle-orm/node-postgres` with `pg`, Drizzle
      Kit, and the repository's existing Effect cohort; no second database ORM
      or Effect version is introduced.
- [x] Database configuration failures are typed Effect errors and the
      PostgreSQL pool is acquired and released through Effect scope.
- [x] Application database guidance requires typed Drizzle plus Effect and
      prohibits avoidable raw SQL strings and direct driver queries.
- [x] PostgreSQL schema name `core` is preserved exactly and contains all 18
      referenced Core tables with preserved MVP2 structure plus documented
      corrections required by the current Action lifecycle.
- [x] Exact-set verification reports no missing Core tables and no unexpected
      Core tables.
- [x] `core.action_invocations` can be persisted before authentication and can
      represent an indeterminate commit result.
- [x] The Drizzle configuration, runtime schema, migration, and verification
      contain no `auth`, `ticketing`, `properties`, `property`, `accounting`,
      or other MicroVertical schema or table.
- [x] After migration, the `ontos` database contains no OntOS application
      tables outside the 18 tables in schema `core`; `public` is empty of
      application tables. PostgreSQL system objects and Drizzle migration
      bookkeeping are the only excluded infrastructure metadata.
- [x] Fresh generated migration history is committed, applies successfully to
      the new empty `ontos` database, and a second migration run is a no-op.
- [x] Typed Drizzle verification reaches every promoted table without
      handwritten application SQL.
- [x] Existing login-page work and every other pre-existing worktree change
      remain untouched.
- [x] All focused database checks and the repository's final quality gate
      pass.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `docker compose config` — Validate the `ontos` project, `.env`
  interpolation, service, health check, port, and volume configuration.
- `docker compose up -d --wait ontos-db` — Create/start the requested
  PostgreSQL container and wait for it to become healthy.
- `docker compose exec -T ontos-db sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`
  — Prove the configured `ontos` database accepts connections.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Run Core
  configuration, Effect resource, and static schema contract tests.
- `mise exec -- pnpm db:generate` — Prove typed schema sources and committed
  migration metadata are synchronized and produce no unreviewed extra
  migration.
- `mise exec -- pnpm db:migrate` — Apply the Core-only migration history to
  the local database.
- `mise exec -- pnpm db:migrate` — Prove a second migration run is
  idempotent.
- `mise exec -- pnpm db:verify` — Reach every promoted table through typed
  Drizzle references and prove exact 18-table Core parity—no missing Core table
  and no unexpected OntOS application table or schema.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant
      referenced guidance.
- [x] Behavioral changes have tests.
- [x] The migration owns exactly PostgreSQL schema `core`; Auth and
      MicroVertical schemas are absent.
- [x] Final catalog verification proves exact 18-table Core equality rather
      than checking only a subset of tables.
- [x] No Auth or MicroVertical implementation is imported, copied, generated,
      migrated, or modified.
- [x] Expected configuration/database failures remain declared typed Effect
      errors.
- [x] Application queries use typed Drizzle APIs; raw SQL exceptions are
      narrow, parameterized, documented, and tested.
- [x] Generated migration SQL was reviewed and was not manually substituted
      for typed schema source.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Scope is deliberately limited to the existing MVP2 PostgreSQL schema named
  `core` and its 18 tables. The `auth` schema and every MicroVertical/business
  schema—including `ticketing`, `properties`, `property`, and `accounting`—are
  explicitly out of scope. No unresolved ownership decision remains.
- MVP2 is a read-only experiment and remains unchanged. Its central Drizzle
  config and mixed-schema historical migrations are evidence, not files to
  copy into the current Core-only migration history.
- MVP2's `action_invocations.principal_id` is non-null and its status check
  omits `indeterminate`. Exact copying would violate current authoritative
  Action rules, so promotion must preserve current behavior rather than
  experiment-era constraints.
- Docker Compose project names permit lowercase letters, digits, dashes, and
  underscores. The requested “Ontos” Docker Desktop group is therefore
  represented by top-level `name: ontos`; the container itself remains exactly
  `ontos-db`.
- PostgreSQL host port `5433` and PostgreSQL 17 Alpine deliberately follow the
  MVP2 local reference. Container-to-container PostgreSQL connections, if
  introduced later, use service host `ontos-db` and port `5432`; host
  application tooling uses `localhost:5433`.
- The login page and its test/tooling changes are part of the current
  `develop` baseline. Implementation must preserve that behavior while
  coordinating intentional edits to `package.json`, `pnpm-lock.yaml`, and
  `scripts/validate-ultramodern-workspace.mts`.

## Implementation Evidence

### Summary

- Added the local PostgreSQL 17 Compose contract, typed Effect-managed
  node-postgres/Drizzle infrastructure package, exact 18-table `core` schema,
  fresh baseline migration, exact-set verifier, and authoritative database
  guidance.
- Reconciled `core.action_invocations` with the current pre-authentication and
  indeterminate-outcome lifecycle while preserving the promoted Core
  constraints, foreign keys, indexes, and delete behavior.

### Changed Files

30 files changed, 6,556 insertions(+), 12 deletions(-).

### Tests Written or Updated

- `packages/core-runtime/tests/unit/config.test.ts` — proves root environment
  discovery is invocation-directory independent, valid and invalid
  configuration behavior remains typed, and pool finalization runs on scope
  close.
- `packages/core-runtime/tests/unit/schema-contract.test.ts` — proves exact
  Core table registration, no foreign schema registration, pre-auth Action
  nullability, lifecycle status typing/checks, foreign keys, and unique
  indexes.
- `packages/core-runtime/tests/unit/catalog-contract.test.ts` — proves exact-set
  comparison reports both a missing Core table and unexpected application
  tables/schemas.

### Validation

- `docker compose config` — passed.
- `docker compose up -d --wait ontos-db` — passed; service healthy.
- `docker compose exec -T ontos-db sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` — passed.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — passed; 10 tests.
- `mise exec -- pnpm --filter @app/core-runtime typecheck` — passed.
- `mise exec -- pnpm db:generate` — passed; 18 tables and no schema changes
  after the committed baseline.
- `mise exec -- pnpm db:migrate` — passed.
- `mise exec -- pnpm db:migrate` — passed again without reapplying schema
  objects.
- `mise exec -- pnpm db:verify` — passed; 18 typed tables, exact application
  catalog, and one migration bookkeeping table verified.
- `mise exec -- pnpm check` — passed.
- `mise exec -- pnpm build` — not run; the change adds server-only database
  infrastructure and does not affect shell build output, Module Federation,
  routing, or browser/runtime bundling.
- Browser validation — not run; there is no user-facing behavior.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `MICROVERTICALS.md`, `ACTIONS.md`,
  `ERRORS.md`, `ULTRAMODERN.md`, `DATABASE.md`, Core/storage product guidance,
  and the relevant PostgreSQL/modular-monolith ADRs.
- Reviewed the complete source, generated SQL and metadata, topology/validator
  changes, dependency cohort, status, diff check, and schema-boundary searches.
  Fixed one review finding: the environment-discovery test now uses the
  committed root `.env.example` so clean checkouts do not depend on local
  untracked state. No screenshots apply.

### Deviations and Follow-ups

- `packages/core-runtime/tsconfig.json` uses package-local `skipLibCheck` because
  Drizzle ORM 0.45.2 publishes optional-driver declarations that are not TS7
  clean. Core source, tests, scripts, and the repository quality gate remain
  fully checked.
