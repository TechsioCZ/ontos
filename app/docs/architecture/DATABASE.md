# Database Architecture

For operation-scope validation, scoped owner services, RLS, runtime/admin roles, and same-tenant
constraints, also follow [Governed Data Access and Operation Scope](./DATA_ACCESS.md). Business
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
- Code outside an owning package must not import a private schema, repository,
  migration, or database client from that package.

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

Core verification must reach every table through its typed Drizzle reference
and compare the final PostgreSQL application-table catalog with the exact Core
inventory. PostgreSQL system catalogs and Drizzle's migration bookkeeping are
infrastructure metadata; no Auth or MicroVertical schema may be excluded from
that comparison.
