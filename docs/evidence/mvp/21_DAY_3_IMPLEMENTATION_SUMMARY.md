# Day 3 Implementation Summary

Date: 2026-06-10

> [!IMPORTANT]
> **Historical record:** The one-BetterAuth-user/one-Tenant/no-selector model described here was superseded by [OntOS #78](https://github.com/TechsioCZ/ontos/issues/78) and [ADR-0014](../../adr/0014-authenticated-principal-session.md). This document records the Day 3 implementation and is not current identity architecture.

Day 3 now implements the MVP foundation for tenant-scoped auth/context/authz probes without implementing Actions, audit, domain events, outbox, canonical writes, or module-owned business-row writes.

## Implemented

- Added `mvp/docker-compose.yml` with local Postgres and real Dockerized SpiceDB.
- Added `mvp/.env.example` with local database, BetterAuth, demo-user, and SpiceDB defaults.
- Added `mvp/scripts/init.sql` from `diagrams/core-db-resource-ref-v0.mmd` as the OntOS schema source of truth, including all ERD tables, constraints, and targeted indexes.
- Added real self-hosted BetterAuth config in `@mvp/core-runtime`, backed by Postgres through the official BetterAuth PostgreSQL/Kysely path.
- Added `@mvp/core-runtime` with:
  - BetterAuth handler export.
  - Drizzle/Postgres reads for tenant, legal entity, principal binding, and module states.
  - RuntimeContext resolution from BetterAuth session to OntOS tenant/principal/legal entity.
  - Real SpiceDB write permission check through `@authzed/authzed-node`.
  - Module-state gate and typed policy gate.
- Added `@mvp/shared-effect-api` Day 3 request/response contracts and endpoint paths.
- Added Shell BFF entry at `mvp/apps/shell-super-app/api/effect/index.ts`.
- Added Shell read-only runtime context panel with demo login buttons and no tenant selector.
- Added Accounting Core probe buttons for:
  - `property.registry` write check.
  - `accounting.core` write check.
  - missing context.
  - module-state deny.
  - policy deny.
  - validation deny.
- Added repeatable seed scripts:
  - `mvp/scripts/seed-day3.mjs`
  - `mvp/scripts/seed-spicedb.mjs`
  - `mvp/scripts/spicedb/schema.zed`
- Added Day 3 acceptance checks in `mvp/tests/day-3.acceptance.test.mjs`.

## Commands

Run from `mvp/`:

```bash
cp .env.example .env
pnpm install
pnpm db:up
set -a && source .env && set +a
pnpm day3:seed
pnpm dev:shell
```

Useful individual commands:

```bash
pnpm db:init
pnpm db:seed
pnpm spicedb:seed
pnpm check
```

Demo users all use `DEMO_USER_PASSWORD`, defaulting to `password1234`:

- `demo-admin-a@example.test`
- `demo-viewer-a@example.test`
- `demo-admin-b@example.test`

## Expected Day 3 Scenarios

- `demo-admin-a` can write `property.registry` in `tenant-a`.
- `demo-admin-a` cannot write `accounting.core` in `tenant-a`.
- `demo-viewer-a` cannot write `property.registry` in `tenant-a`.
- `demo-admin-b` can write `property.registry` in `tenant-b`.
- `demo-admin-b` cannot write `property.registry` in `tenant-a`.

The Shell panel shows the BetterAuth user, OntOS principal, tenant, legal entity, and module states read-only. One BetterAuth user resolves to exactly one OntOS tenant. There is no tenant selector.

## No Day 3 Runtime Writes

The Day 3 BFF probes only resolve context and return typed gate decisions. Runtime probes do not insert canonical business rows, `core_action_invocations`, audit events, data-access events, domain events, outbox messages, evidence rows, property rows, or billing rows.

Setup and seed scripts intentionally write schema, demo auth users, OntOS tenant/principal/module-state seed rows, and SpiceDB schema/relationships.

## Updated MVP Runtime Requirements

After the runtime-attempt validation on 2026-06-15, the next MVP work should not add `SystemIntent` as a public concept or generic persisted payload. Use the existing Action/DataAccess vocabulary:

- write attempts are registered Actions backed by `CORE_ACTION_INVOCATIONS`, audit checkpoints, domain events, and outbox messages.
- read/list/search/export attempts are data-access operations backed by `CORE_DATA_ACCESS_EVENTS` and optional `CORE_EVIDENCE_REFERENCES`.
- Shell BFF handlers remain typed transport adapters inside the unified Application Runtime.
- Core may use an internal `OperationalContext`, but stages should return typed results rather than mutating a shared bag.
- Day 5 must prove denial, success, failure, and idempotency replay/conflict transaction boundaries before the MVP runtime is treated as production-ready.

The follow-up experiment should be `mvp2/`, based on the latest UltraModern.js scaffold. It should use CoreSDK as the required server-side execution boundary and `OperationalContext` as internal runtime context. See `22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md`.

## Validation

Passed:

```bash
pnpm install
pnpm --filter @mvp/shared-effect-api typecheck
pnpm --filter @mvp/core-runtime typecheck
pnpm --filter @mvp/accounting-core typecheck
pnpm --filter @mvp/shell-super-app typecheck
pnpm test:acceptance
pnpm check
pnpm --filter @mvp/shell-super-app build
docker compose config
node --check scripts/seed-day3.mjs
node --check scripts/seed-spicedb.mjs
```

Blocked:

```bash
pnpm db:up
```

The Docker daemon was not running in this environment:

```text
failed to connect to the docker API at unix:///Users/jiprochazka/.docker/run/docker.sock
```

Because of that, the live Postgres schema/seed, live SpiceDB seed, and browser-click scenario proof were not run here.

## Deviations

- BetterAuth/auth are pinned to `1.6.15`, not `1.6.16`, because this repository enforces `minimumReleaseAge: 1440` and `1.6.16` was published on 2026-06-10 inside the cutoff. `1.6.15` was published on 2026-06-08 and exposes the same table shape used by the local SQL bootstrap.
- SpiceDB uses Dockerized `authzed/spicedb:latest` with the memory datastore for Day 3. Seed scripts make the state repeatable after service restart.
