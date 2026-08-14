---
type: feature
status: done
created: 2026-08-13
---

# Feature: CRM Customer and Contact persistence

## Feature Description

Add the first CRM-owned business entities to PostgreSQL: a Customer with a name and a Contact with
a name, email, phone, and exactly one parent Customer. A Customer represents either a company or a
person without introducing a discriminator yet. Both entities have durable UUID identity,
tenant ownership, timestamps, and a nullable archive timestamp.

The change establishes the CRM MicroVertical as an independent Drizzle migration owner for the
PostgreSQL schema named exactly `crm`, adds owner-private typed database access and inferred entity
types, generates and applies the migration, and verifies the live schema and tenant isolation. It
does not add Actions, reads, BFF endpoints, public resource descriptors, or UI.

## User Story

As an OntOS CRM developer
I want typed Customer and Contact persistence owned by the CRM MicroVertical
So that later generated Actions can safely create, update, archive, and read CRM records without
reopening the database ownership design

## Problem Statement

The CRM MicroVertical exists but owns no database schema, migration history, or domain tables.
Later CRM behavior therefore has no canonical, tenant-isolated place to persist Customers and their
Contacts. Adding the tables through Core or `public` would violate MicroVertical ownership, while
an untyped or globally shared database client would bypass the governed data-access architecture.

## Solution Statement

Create an owner-local Drizzle configuration and database boundary in `verticals/crm`, with the
distinct journal `drizzle.__drizzle_migrations_crm`. Define `crm.customers` and `crm.contacts` as
explicit typed Drizzle tables. Both are tenant-owned and protected by enabled and forced tenant
RLS; Contact uses a composite `(tenant_id, customer_id)` foreign key so it cannot belong to a
Customer from another tenant. Archiving is represented by nullable `archived_at`, and no hard-delete
or archive operation is exposed in this increment.

Keep the current business shape deliberately small. Customer has only `name`; Contact has `name`,
`email`, and `phone`. Colocate `CustomerRecord`, `NewCustomerRecord`, `ContactRecord`, and
`NewContactRecord` as Drizzle-inferred, owner-private entity types in the CRM schema module instead
of inventing a separate unused domain abstraction. Future Action generators will own operation
payload/result schemas without coupling public contracts to persistence row types.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory Codesmith generator rules.
- `AGENTS.md` — authoritative MicroVertical, database, data-access, and toolchain constraints.
- `README.md` — current migration/runtime-role workflow and database-owner documentation.
- `package.json` — root database generation, migration, test, and verification orchestration.
- `pnpm-workspace.yaml` — dependency policy and pinned Drizzle/Effect cohort.
- `verticals/crm/package.json` — CRM-owned dependencies and focused database scripts.
- `verticals/crm/tsconfig.json` — CRM compilation boundary that must include the owner-private database code.
- `packages/core-runtime/src/db/scoped-transaction.ts` — existing typed tenant RLS helpers to reuse.
- `packages/core-runtime/src/db/config.ts` — shared typed database URL parsing and connection-pair loading.
- `packages/core-runtime/drizzle.config.ts` — established owner-specific Drizzle configuration pattern.
- `packages/core-runtime/src/db/schema.ts` — typed table, inventory, UUID, timestamp, index, check, and RLS conventions.
- `packages/core-runtime/scripts/verify-db-schema.mts` — Core owner verification that must remain exact while accepting global CRM ownership through the root verifier.
- `apps/shell-super-app/drizzle.auth.config.ts` — distinct non-Core migration journal pattern.
- `apps/shell-super-app/scripts/verify-auth-db-schema.mts` — Auth owner verification that must remain exact while accepting global CRM ownership through the root verifier.
- `scripts/postgres/bootstrap-runtime-role.mts` — least-privilege runtime grants that must include `crm`.
- `scripts/verify-application-db-schema.mts` — global application schema/journal verification and owner verifier orchestration.
- `scripts/check-database-access-boundaries.mts` — enforcement that later handlers cannot import a database executor directly.
- `docs/architecture/DATABASE.md` — authoritative schema ownership and typed Drizzle-plus-Effect rules.
- `docs/architecture/DATA_ACCESS.md` — tenant RLS, scoped owner services, and trusted operation-context rules.
- `docs/architecture/MICROVERTICALS.md` — CRM ownership and independent migration/deployment seam.
- `docs/architecture/ULTRAMODERN.md` — infrastructure-file and unsupported business-artifact rules.
- `../docs/08_CANONICAL_ENTITY_MODEL.md` — explicit module-owned domain table and stable resource identity guidance.
- `../docs/10_DATA_STORAGE_AND_PROJECTIONS.md` — PostgreSQL canonical-store and per-vertical schema requirement.

### New Files

- `verticals/crm/drizzle.config.ts` — CRM Drizzle Kit configuration using `DATABASE_ADMIN_URL`, schema `crm`, output `drizzle/`, and journal `drizzle.__drizzle_migrations_crm`.
- `verticals/crm/src/db/schema.ts` — typed Customer and Contact tables, constraints, indexes, RLS policies, exact inventory, and inferred owner-private entity types.
- `verticals/crm/src/db/catalog.ts` — pure exact-inventory comparison for CRM schema verification.
- `verticals/crm/src/db/client.ts` — scoped Effect-managed CRM `pg` pool and typed Drizzle client.
- `verticals/crm/src/db/connection-error.ts` — typed expected CRM connection failure.
- `verticals/crm/src/db/types.ts` — CRM Drizzle executor and transaction types.
- `verticals/crm/scripts/verify-db-schema.mts` — live CRM schema, typed-query, constraint, RLS, owner, journal, and runtime-role verification.
- `verticals/crm/tests/unit/schema-contract.test.ts` — static table, column, type, relationship, archive, index, and RLS contract tests.
- `verticals/crm/tests/unit/catalog-contract.test.ts` — exact CRM catalog-difference tests.
- `verticals/crm/tests/unit/database-client.test.ts` — scoped pool finalization and typed connection-failure tests.
- `verticals/crm/tests/integration/database-boundary.test.ts` — migrated schema, runtime grants, tenant isolation, parent relationship, and archive persistence tests.
- `verticals/crm/drizzle/*.sql` and `verticals/crm/drizzle/meta/**` — generated CRM migration and metadata; do not hand-author an alternative migration.

## Implementation Plan

### Phase 1: Foundation

Create a fresh worktree and branch from the intended `develop` base, then establish CRM as the
third independent database owner. Reuse Core's public database configuration and RLS helpers while
keeping the CRM pool, Drizzle schema, executor types, migrations, and verification private to the
CRM package.

### Phase 2: Core Implementation

Define the minimal Customer and Contact tables and inferred entity types. Add exact schema contract
tests beside the schema, including archive representation, required business fields, composite
same-tenant parent integrity, indexes, and tenant RLS. Add integration coverage that proves the
runtime role sees and writes only the installed tenant scope.

### Phase 3: Integration

Add CRM to root migration, grants, tests, and global verification without registering CRM tables in
Core or Auth. Generate and inspect the Drizzle migration, apply it to PostgreSQL, rerun it to prove
idempotence, verify the exact live catalog, and finish with all focused and repository-wide gates.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Create the isolated implementation worktree

- [x] From the repository root, confirm the target base and local worktree list, then create a fresh worktree at `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-crm-customer-contact-persistence` on branch `codex/feature-crm-customer-contact-persistence`; run all remaining commands from that worktree's `app/` directory.
- [x] Do not reuse or edit the existing CRM roadmap worktrees (`codex/feature-crm-02-foundation`, `codex/feature-crm-03-customer-backend`, or `codex/feature-crm-05-contact-backend`): they are based on a different history and contain broader, conflicting Customer/Contact models.

### 2. Establish CRM-owned Drizzle infrastructure

- [x] Update `verticals/crm/package.json` and `pnpm-lock.yaml` with the repository-pinned `drizzle-orm`, `drizzle-kit`, `dotenv`, `pg`, and `@types/pg` dependencies plus `db:generate`, `db:migrate`, `db:verify`, `db:test`, `test:unit`, and `test:integration` scripts.
- [x] Add `verticals/crm/drizzle.config.ts` following the current Core/Auth pattern: load the root environment without reading secrets into source, require `DATABASE_ADMIN_URL`, target only `verticals/crm/src/db/schema.ts`, write to `verticals/crm/drizzle`, and use `drizzle.__drizzle_migrations_crm` so another owner's timestamps cannot suppress CRM migrations.
- [x] Add the scoped CRM database client, local typed connection error, executor types, and exact catalog helper under `verticals/crm/src/db/`; reuse the public Core configuration parser and keep the pool/executor private to CRM infrastructure.
- [x] Add unit tests for pool acquisition/finalization, typed connection failure, and exact catalog mismatch reporting before adding live database behavior.

### 3. Define the Customer and Contact entities

- [x] In `verticals/crm/src/db/schema.ts`, declare `CRM_SCHEMA_NAME = 'crm'`, exact inventory `['contacts', 'customers']`, `crmSchema`, and the two explicit tables; do not add either table to Core/Auth schema objects or public package exports.
- [x] Define `crm.customers` with `customer_id`, `tenant_id`, required trimmed non-empty `name`, `created_at`, `updated_at`, and nullable `archived_at`. Do not add a company/person discriminator or any other Customer business field in this increment.
- [x] Define `crm.contacts` with `contact_id`, `tenant_id`, `customer_id`, required trimmed non-empty `name`, required non-empty `email`, required non-empty `phone`, `created_at`, `updated_at`, and nullable `archived_at`.
- [x] Add tenant-qualified unique identities, active-record lookup indexes, and a composite `(tenant_id, customer_id)` Contact-to-Customer foreign key with `ON DELETE RESTRICT`; do not make names, emails, or phone numbers unique.
- [x] Apply `enableGovernedRls` and `tenantRlsPolicies` to both tables so generated SQL enables and forces RLS and creates select/insert/update/delete policies for `ontos_runtime` based only on transaction-local `ontos.tenant_id`.
- [x] Export `CustomerRecord`, `NewCustomerRecord`, `ContactRecord`, and `NewContactRecord` from the schema module using Drizzle's `$inferSelect`/`$inferInsert`; add compile-time and runtime schema-contract assertions proving their fields and nullable archive timestamp stay aligned with storage.

### 4. Test the schema and generate the migration

- [x] Add `verticals/crm/tests/unit/schema-contract.test.ts` to assert the exact two-table inventory, physical schema/name, column names and nullability, archive columns, defaults, check constraints, indexes, forced-RLS configuration, policies, and composite restrictive foreign key.
- [x] Run `mise exec -- pnpm --filter @app/crm test:unit`, then `mise exec -- pnpm --filter @app/crm db:generate`; inspect the generated SQL and metadata to confirm it creates only schema `crm`, the two tables, constraints/indexes, enabled and forced RLS, policies, and the CRM-specific migration journal.
- [x] Do not replace generated SQL with a handwritten migration. Add only a documented narrow migration SQL adjustment if Drizzle cannot express a verified requirement.

### 5. Integrate the third database owner

- [x] Update root `package.json` so `db:generate`, `db:migrate`, and `db:test` include `@app/crm` in deterministic Core, Auth, CRM order, with runtime-role bootstrap still running after migrations.
- [x] Update `scripts/postgres/bootstrap-runtime-role.mts` to grant `ontos_runtime` usage and table/sequence DML privileges for `crm` without `CREATE`, superuser, or `BYPASSRLS` capability.
- [x] Refactor `packages/core-runtime/scripts/verify-db-schema.mts` and `apps/shell-super-app/scripts/verify-auth-db-schema.mts` to verify only their own exact table inventories and owner-specific journals. Extend `scripts/verify-application-db-schema.mts` to exact-match global application schemas `auth`, `core`, and `crm`, exact-match all three journals, and invoke all three owner verifiers.
- [x] Update the database-owner wording in `README.md` to include CRM while preserving the rule that every MicroVertical owns a separate schema/history.

### 6. Prove migration, relationship, archiving, and isolation behavior

- [x] Apply `mise exec -- pnpm db:migrate` to a clean or disposable PostgreSQL database, run the same command a second time to prove no migration is reapplied, and run `mise exec -- pnpm db:verify` to reach both CRM tables through typed Drizzle references and verify exact catalogs, journal, constraints, RLS, ownership, and least-privilege grants.
- [x] Add `verticals/crm/tests/integration/database-boundary.test.ts` using the administrative identity only for fixture setup/inspection and `ontos_runtime` for application behavior. Prove missing tenant scope exposes no rows and permits no writes; one tenant cannot read/update another tenant's rows; a Contact requires an existing same-tenant Customer; one Customer accepts multiple Contacts; and both nullable archive timestamps can be persisted without deleting rows.
- [x] Verify the integration test cleans up only its own deterministic fixtures or uses a disposable database, and never weakens RLS or grants to make assertions pass.

### 7. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without changing UI, API/BFF contracts, Action descriptors, module manifests, or generated route files.

## Testing Strategy

### Unit Tests

Test exact CRM table ownership, required/minimal fields, archive timestamp nullability, inferred row
and insert types, generated defaults, non-empty string checks, indexes, composite same-tenant
foreign key, RLS/policy definitions, exact catalog comparisons, and scoped pool lifecycle/errors.

### Integration Tests

Apply the generated CRM migration to PostgreSQL and exercise the live tables as the least-privilege
runtime role. Verify exact migration bookkeeping, admin ownership, runtime grants, forced tenant
RLS, cross-tenant denial, same-tenant Customer/Contact integrity, multiple Contacts per Customer,
and non-destructive archive timestamps. No browser or BFF test is required because this increment
adds no public operation or UI surface.

### Edge Cases

- A Customer name is empty or padded with whitespace.
- A Contact name, email, or phone is empty.
- A Contact references a missing Customer or a Customer in another tenant.
- Multiple Contacts reference the same Customer.
- The same name, email, or phone appears on multiple records and remains allowed.
- `archived_at` is null for active rows and a timestamp for archived rows without deleting either the Customer or its Contacts.
- Runtime access occurs with a missing, malformed, or different `ontos.tenant_id` setting.
- The database already contains an unexpected CRM table, application schema, or migration journal.

## Acceptance Criteria

- [x] Implementation work occurs in the fresh `codex/feature-crm-customer-contact-persistence` worktree, without modifying existing CRM worktrees.
- [x] CRM owns a distinct Drizzle history in `drizzle.__drizzle_migrations_crm` and exactly two application tables in PostgreSQL schema `crm`.
- [x] Customer supports either company or person using only one required `name` business field; no discriminator or extra Customer business field is added.
- [x] Contact has required `name`, `email`, and `phone` fields and belongs to exactly one same-tenant Customer; one Customer can have many Contacts.
- [x] `archived_at` can represent archived Customers and Contacts without deleting their rows.
- [x] Owner-private `CustomerRecord`, `NewCustomerRecord`, `ContactRecord`, and `NewContactRecord` types are inferred from the authoritative Drizzle schema.
- [x] Both tables use enabled and forced tenant RLS, and the runtime role cannot access or mutate another tenant's rows.
- [x] The generated migration is committed, applied successfully, and idempotent on a second run.
- [x] Core and Auth retain exact ownership of their own schemas and journals while root verification recognizes CRM as the third owner.
- [x] No UI, route, BFF/API, Action, Policy, Outbox Message, public manifest, or cross-MicroVertical persistence change is included.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate schema/type/catalog/client contracts without PostgreSQL.
- `mise exec -- pnpm --filter @app/crm db:generate` — prove the committed CRM migration matches the typed schema and produces no additional drift after generation.
- `mise exec -- pnpm db:migrate` — apply Core, Auth, and CRM migration histories and refresh least-privilege runtime grants.
- `mise exec -- pnpm db:migrate` — prove the complete migration orchestration is idempotent.
- `mise exec -- pnpm db:verify` — exact-match all application schemas/journals and verify every owner through typed table references.
- `mise exec -- pnpm --filter @app/crm test:integration` — prove live CRM constraints, archiving, runtime grants, and tenant RLS behavior.
- `mise exec -- pnpm database-access:check` — ensure CRM persistence remains owner-local and unavailable to future handlers as a raw executor.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Customer and Contact are tenant-wide CRM resources. No `legal_entity_id` is stored because the request does not assign either entity to one managed Legal Entity; future Action/read descriptors must still declare legal-entity scope independently.
- Contact `name`, `email`, and `phone` are treated as required because the request names all three fields without marking any optional. Email/phone format validation belongs to later generated Actions; this increment enforces only non-null, non-empty stored strings.
- `archived_at` is the sole lifecycle marker in this increment. No status enum, restore semantics, cascade archival, or automatic exclusion query is added before Actions/reads exist.
- The typed entities are deliberately Drizzle-inferred persistence records, not public API contracts. This avoids an unused abstraction and avoids hand-authoring an unsupported new business-artifact category; no Codesmith business generator is required for this database-only increment.
- Several pre-existing CRM worktrees contain older, broader models (company-only Customer, split Contact names, extra fields, and soft deletion). They are not merged into the current `develop` base and conflict with this request, so the new implementation must not cherry-pick them wholesale.

## Implementation Evidence

### Summary

- Added CRM-owned Drizzle configuration, private typed database infrastructure, exact catalog verification, and inferred Customer/Contact persistence types.
- Added exactly `crm.customers` and `crm.contacts` with tenant-qualified identity, same-tenant parent integrity, archive timestamps, active-record indexes, complete tenant policies, and enabled/forced RLS.
- Generated the CRM migration and added only the documented FORCE-RLS SQL adjustment that Drizzle cannot express.
- Integrated CRM as the third migration owner in root orchestration, runtime grants, exact global verification, owner-local verification, documentation, and test discovery.
- Reconciled the generated UltraModern workspace contract and CRM locale/federation entry wiring so the repository-wide quality gate covers the already-present CRM deployment.
- Corrected fresh-database migration ordering so the runtime role exists before CRM tenant-policy creation, while schema grants are refreshed after CRM migration.

### Changed Files

- 31 files changed; 2,871 insertions and 155 deletions (3,026 changed lines), including generated migration metadata and this specification/evidence file.

### Tests Written or Updated

- `verticals/crm/tests/unit/catalog-contract.test.ts` — exact CRM catalog matching and mismatch reporting.
- `verticals/crm/tests/unit/database-client.test.ts` — scoped pool finalization and typed pool-construction failure.
- `verticals/crm/tests/unit/schema-contract.test.ts` — exact tables/columns/types/defaults, inferred types, constraints, indexes, same-tenant FK, policies, and FORCE-RLS migration adjustment.
- `verticals/crm/tests/integration/database-boundary.test.ts` — missing/malformed scope, cross-tenant reads/updates, required string checks, missing/foreign Customer parents, duplicate business values, multiple Contacts, and durable Customer/Contact archiving using the runtime role.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed (10 tests).
- `mise exec -- pnpm --filter @app/crm db:generate` — passed; no schema drift or additional migration.
- `mise exec -- pnpm db:migrate` — passed twice against disposable database `ontos_crm_contact_persistence_test`; second run was idempotent.
- `mise exec -- pnpm db:verify` — passed; exact global schemas/journals and Core/Auth/CRM owner verification succeeded.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed (1 comprehensive live-database test).
- `mise exec -- pnpm database-access:check` — passed.
- `mise exec -- pnpm check` — passed, including format, lint, Action unit tests, typecheck, skills, i18n, API/database boundaries, module entrypoints/contracts, generated workspace contract, and performance readiness.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm contract:check` — passed after reconciling the generated workspace contract with the current CRM/Shell topology.
- `mise exec -- pnpm performance:readiness` — passed.
- `mise exec -- pnpm build` — passed from a clean commit, including CRM and Shell production builds, Node deployment materialization, Module Federation type verification, and performance readiness.
- Browser validation — not applicable because the feature adds no UI, route, or public operation.

### Review

- Re-read and reviewed the final implementation against `../AGENTS.md`, `AGENTS.md`, the complete specification, `README.md`, `docs/architecture/{DATABASE,DATA_ACCESS,MICROVERTICALS,ACTIONS,ERRORS,ULTRAMODERN}.md`, and `../docs/{08_CANONICAL_ENTITY_MODEL,10_DATA_STORAGE_AND_PROJECTIONS}.md`.
- Fixed review findings: changed the Customer composite identity to a typed unique constraint so generated migration ordering is valid; matched table ownership to the configured admin identity; verified CRM schema usage/no-create grants; expanded live failures for Contact name/email/phone; removed a forbidden root Effect suppression.
- `git diff --check` and formatting pass. No UI screenshots apply.

### Deviations and Follow-ups

- The developer authorized fixing the baseline CRM locale and generated workspace-contract failures required to make the branch PR-ready. The repairs preserve existing public contracts and add no business behavior.
- The first un-overridden migration attempt hit the already-running shared database's non-example credentials; all required migration and verification evidence was rerun successfully on the disposable task-specific database.
- No push, pull request, or issue was created.
