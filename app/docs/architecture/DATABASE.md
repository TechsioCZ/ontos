# Database Architecture

For operation-scope validation, scoped owner services, RLS, runtime/admin roles, and same-tenant
constraints, also follow [Governed Data Access and Operation Scope](./DATA_ACCESS.md). The current
effective-role evidence and trusted-context limitations are recorded in
[Database Trust-Boundary Audit](./DATABASE_TRUST_BOUNDARIES.md). Business
handlers and BFF adapters never receive or import a database executor; owner repositories are built
inside a Core-owned scoped transaction.

This document defines authoritative database access and schema-ownership rules
for the OntOS application. MicroVertical deployment boundaries remain governed
by [MicroVertical Architecture](./MICROVERTICALS.md), and state changes remain
governed by [Action Execution](./ACTIONS.md).

## Ownership

- `@app/core-runtime` owns only the PostgreSQL schema named exactly `core`.
- The `core` migration history contains only Core infrastructure tables.
- PostgreSQL schema `public` owns no OntOS application tables.
- Auth and every MicroVertical own separate schemas and migration histories.
  They are not registered in the Core Drizzle configuration or runtime schema.
- All migration histories store bookkeeping in the shared PostgreSQL schema
  `drizzle`, using a distinct journal table per owner. Independent migration
  histories must never share one journal table because their timestamps would
  suppress each other's migrations.
- Each owner history uses the Drizzle v1 layout: one folder per migration
  named `<timestamp>_<tag>` that holds `migration.sql` and `snapshot.json`.
  There is no `meta/_journal.json`. Never hand-edit a committed `migration.sql`
  or renumber a folder; the bookkeeping table matches rows by folder name and
  content hash. The upgrade record and re-proof sequence live in
  [Drizzle v1 Upgrade](./DRIZZLE_V1_UPGRADE.md).
- Code outside an owning package must not import a private schema, repository,
  migration, or database client from that package.

## Drizzle Cohort

OntOS runs the Drizzle v1 release candidate (`drizzle-orm` and `drizzle-kit`
`1.0.0-rc.4`) pinned identically in every owner, together with Better Auth
`1.7.2` and its `@better-auth/drizzle-adapter/relations-v2` entrypoint. Bump the
pair only as one cohort and only through the proofs in
[Drizzle v1 Upgrade](./DRIZZLE_V1_UPGRADE.md).

Owner conventions on v1:

- Declare relations with `defineRelations(<tables>, (r) => ...)` and construct
  executors with `drizzle({ client, relations })`. Executor types are
  `NodePgDatabase<typeof <owner>Relations>`. Relational Queries v1
  (`relations(...)`, callback `where`) are unavailable.
- Declare governed tables with `<schema>.table.withRLS(...)` and attach
  `tenantRlsPolicies` or `tenantLegalEntityRlsPolicies` from `@app/core-runtime`.
- Use `getColumns` instead of the deprecated `getTableColumns`.
- After adding a migration or rebasing a branch that adds one, run
  `pnpm db:check`; it validates each owner's snapshot chain and reports
  non-commutative migrations across branches.

## Typed Drizzle and Effect

Every application query and mutation must:

1. run inside an Effect service;
2. use the owning package's typed Drizzle table and column references;
3. use Drizzle query builders for selects, inserts, updates, deletes, and
   transactions; and
4. preserve expected failures in a declared Effect error channel.

Application code must not use direct `pg` queries, interpolated SQL strings,
string-concatenated SQL, untyped result objects, or exported promise-only
database APIs when Drizzle and Effect can represent the behavior. The
node-postgres pool is a private implementation detail acquired and released by
an Effect scope.

## Narrow SQL Exceptions

Drizzle's parameterized `sql` tagged template is allowed only for:

- typed schema checks, index predicates, and defaults;
- migration or bootstrap work; or
- a documented operation that cannot be represented by a Drizzle query
  builder.

Every application-level exception needs a nearby explanation and a focused
test. Parameters must remain values in the tagged template; never construct SQL
by joining or interpolating strings.

Generated migration SQL is an output of the typed schema and is not application
query code. Handwritten migration SQL must not replace an expressible typed
Drizzle schema definition.

## Environment and Lifecycle

Local Compose and application tooling share the root `DATABASE_URL` contract
documented in `.env.example`. Package configuration resolves the root `.env`
by an explicit path, independent of the invocation directory.

Missing or malformed configuration is an expected typed Effect error. There is
no silent localhost fallback. The application database layer owns a `pg.Pool`,
binds it to `drizzle-orm/node-postgres`, and closes it when its Effect scope
ends.

## Core Migration Boundary

The Core schema inventory is an exact set. Migration generation, application
registration, tests, and verification all use
`packages/core-runtime/src/db/schema.ts` as their only schema source.

Each owner verifier must reach every owned table through its typed Drizzle reference and
exact-match only that owner's schema inventory and migration journal. The root application
verifier separately exact-matches the complete set of application schemas and owner-specific
Drizzle journals before invoking every owner verifier. PostgreSQL system catalogs and Drizzle's
migration bookkeeping remain infrastructure metadata rather than a shared business schema.

## Canonical, Projected, and Artifact Data

PostgreSQL is canonical for operational state. Neo4j, search documents, reporting aggregates, and
other read models are projections: they may lag, must be rebuildable, and must not become the only
source for business writes, audit, billing, or authorization. SpiceDB remains the separate
authorization store and must not be used as the business relationship graph.

Binary content belongs in object storage. PostgreSQL owns its metadata, lifecycle, links, evidence
references, and authorization context. Storage keys are collision-resistant technical identifiers,
not user filenames or business hierarchy. Preserve an optional original filename as provenance and
a sanitized display filename for presentation; neither establishes ownership or uniqueness.

After ingest completes, record exact byte size and a SHA-256 hash of the stored bytes. Treat the
storage key, provider object-version reference, size, and content hash as immutable content
identity. Presentation metadata and processing state may change independently.

Legal or compliance immutability requires provider-enforced WORM/Object Lock. Record the requested
and verified provider state in the evidence reference. Database constraints and application
permissions alone provide application-level protection and must not be described as storage-level
WORM.
