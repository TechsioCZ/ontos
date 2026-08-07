---
type: feature
status: in_progress
created: 2026-08-07
---

# Feature: CoreSDK Tenant and Legal-Entity Isolation

## Feature Description

Make tenant and legal-entity isolation a CoreSDK invariant for every governed write and read. The
current Shell resolves an active tenant and authorized legal entity correctly, but the generic
Action runtime accepts a caller-provided `TrustedPrincipalContext`, validates only its shape, and
gives handlers a general Drizzle CRUD surface. Public Shell reads perform explicit authorization
but do not run through a reusable read/evidence runtime. A forgotten predicate can therefore still
become a tenant leak.

Add defense in depth at four layers:

1. Every Action and governed read explicitly declares whether legal-entity context is `required`,
   `optional`, or `forbidden` in addition to the existing tenant/system entrypoint scope.
2. CoreSDK revalidates the tenant, principal, optional auth binding, legal entity, active statuses,
   same-tenant relationship, and SpiceDB legal-entity access before private code can execute.
3. Private handlers receive only owner-local transaction-scoped services. They do not receive raw
   Drizzle CRUD methods or a global database service. Tenant-scoped business tables use PostgreSQL
   row-level security (RLS) under a least-privilege runtime role as the final backstop.
4. Public reads, lists, searches, downloads, reports, and exports run through a typed Core read
   runtime that owns context, module state, authorization, Policy, transaction scope, result
   decoding, and durable allowed/denied data-access evidence.

The implementation must preserve MicroVertical ownership. Core supplies the execution protocol and
opaque transaction capability; each MicroVertical continues to own its schema, migrations,
repositories, repository factory, handlers, and independently deployable BFF.

## User Story

As an authenticated OntOS user
I want every operation to see and modify only data belonging to my resolved tenant and selected legal entity
So that another customer's or legal entity's data cannot leak because an individual handler forgot a predicate

## Problem Statement

The current code proves the interactive Shell selection flow but not the platform invariant required
by `../docs/09_AUTHN_AUTHZ_MODEL.md` and
`../docs/22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md`:

- `TrustedPrincipalContext.legalEntityId` is optional without an operation-level declaration saying
  whether it must or must not be present.
- `ActionRuntime` schema-decodes trusted IDs but does not authoritatively recheck their persisted
  tenant relationship, active state, or legal-entity permission.
- `ActionHandlerContext.transaction` exposes unrestricted `select`, `insert`, `update`, `delete`,
  and relational `query`; omitting a tenant/legal-entity predicate remains possible.
- arbitrary Action Effect requirements can include a database service, and repository checks do not
  currently reject that bypass.
- Core rows that carry both `tenant_id` and a foreign identifier generally use independent foreign
  keys rather than composite same-tenant foreign keys.
- the local runtime connects as the Compose-created PostgreSQL superuser, which would bypass RLS.
- Shell resource/search gates do not create standalone `core.data_access_events`, and the current
  data-access schema lacks an allowed/denied/failed outcome vocabulary.
- generated search/report provider payloads include caller-visible context fields instead of deriving
  identity from a verified server-side assertion.
- tests prove legal-entity lookup and SpiceDB object qualification, but not that an intentionally
  unscoped handler query is blocked by both the CoreSDK capability boundary and PostgreSQL.

## Solution Statement

Introduce one internal `OperationalScope` produced only by CoreSDK after trusted-context
revalidation. Add an explicit `legalEntityScope` declaration to Action and read descriptors. A
`required` operation rejects missing context; `optional` validates it when present; `forbidden`
rejects it when present. Definite mismatches and denials fail before handler resolution, while
database or SpiceDB uncertainty remains a typed retryable failure.

Replace the handler-facing `ActionTransactionExecutor` with a registration-owned, owner-local
service factory. Core invokes that private factory only after opening its transaction, setting
transaction-local tenant/legal-entity PostgreSQL settings, and completing the locked tenant/module
recheck. The factory may build typed owner repositories over an opaque scoped executor; the handler
receives only the returned services plus collector methods. Core database clients and the scoped
executor are not public handler dependencies, and repository boundary validation rejects direct DB
imports from Actions and BFF handlers.

Use Drizzle `pgPolicy`/`enableRLS` for expressible policies on tenant-scoped business tables and a
small reviewed migration statement for `FORCE ROW LEVEL SECURITY` if Drizzle Kit cannot express it.
RLS reads `ontos.tenant_id` and optional `ontos.legal_entity_id` set with parameterized
transaction-local `set_config`; missing settings deny all rows. The runtime connection uses a
non-superuser, non-`BYPASSRLS` role. Migration/admin credentials remain separate. Core's global
catalog/outbox infrastructure is not made tenant-RLS-dependent in this increment; it is protected
from business handlers by package/capability boundaries and gains composite same-tenant
constraints wherever tenant-qualified references exist.

Add a typed read registration/runtime parallel to Actions, without introducing a generic HTTP
endpoint. Owner-specific BFF endpoints call it with a verified session or gateway assertion. It
records metadata-only evidence by default, records definite authorization/Policy denials without
executing the handler, never returns an allowed result until its evidence commits, and does not
store raw queries or result payloads unless the descriptor opts into an already-supported explicit
evidence mode.

## Relevant Files

Use these files to implement the feature:

- `../docs/09_AUTHN_AUTHZ_MODEL.md` — defines tenant as the top-level isolation boundary and tenant leakage as a critical defect.
- `../docs/15_PRE_DEVELOPMENT_VALIDATION_REPORT.md` — requires composite same-tenant keys and foreign keys.
- `../docs/22_MVP2_CORESDK_IMPLEMENTATION_REQUIREMENTS.md` — requires CoreSDK-owned context, safe transaction-scoped services, governed reads, and evidence.
- `../docs/23_CORESDK_OPERATION_FLOW_DESIGN.md` — defines trusted identity, OperationalContext ownership, and owner-local transaction-scoped capabilities.
- `AGENTS.md` — authoritative application boundaries, Effect rules, and Codesmith requirements.
- `docs/architecture/ACTIONS.md` — current Action lifecycle and transaction/evidence ordering.
- `docs/architecture/DATABASE.md` — schema ownership, typed Drizzle access, migration boundaries, and narrow SQL exceptions.
- `docs/architecture/MICROVERTICALS.md` — independent deployment and owner-local repository constraints.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — tenant/system entrypoint scopes, request gates, and generator enforcement.
- `docs/architecture/ERRORS.md` — typed Effect and Problem Details requirements for public failures.
- `.env.example` — current single/superuser-compatible database connection contract.
- `docker-compose.yml` — local PostgreSQL provisioning that currently creates only the administrative user.
- `package.json` — repository database, generator, boundary, test, and quality-gate commands.
- `packages/core-runtime/src/actions/context.ts` — currently exposes the handler-facing unrestricted Drizzle transaction.
- `packages/core-runtime/src/actions/definition.ts` — Action descriptor/registration and private handler storage.
- `packages/core-runtime/src/actions/runtime.ts` — Core Action lifecycle, context shape validation, transaction creation, and handler invocation.
- `packages/core-runtime/src/actions/repository.ts` — Action/evidence persistence and tenant-qualified lookups.
- `packages/core-runtime/src/actions/principal-context.ts` — current trusted principal schema.
- `packages/core-runtime/src/auth/legal-entity-context.ts` — exact tenant/legal-entity existence and active-state checks to reuse.
- `packages/core-runtime/src/auth/principal-resolver.ts` — current Better Auth subject-to-tenant Principal resolution.
- `packages/core-runtime/src/permissions/context-access.ts` — fail-closed legal-entity/module/resource SpiceDB checks.
- `packages/core-runtime/src/db/client.ts` — runtime connection pool and global Core database capability.
- `packages/core-runtime/src/db/config.ts` — current `DATABASE_URL` parsing and runtime configuration.
- `packages/core-runtime/src/db/schema.ts` — tenant-qualified Core tables and `data_access_events` schema.
- `packages/core-runtime/scripts/verify-db-schema.mts` — Core catalog verification to extend with same-tenant constraints and role assertions.
- `apps/shell-super-app/api/auth/service.ts` — active tenant/legal-entity session resolution that feeds trusted Shell operations.
- `apps/shell-super-app/api/auth/legal-entity-selection.ts` — existing authorization-aware legal-entity selection behavior.
- `apps/shell-super-app/api/index.ts` — public Shell read endpoints and gateway assertion issuing.
- `apps/shell-super-app/api/modules/shell-resources.ts` — current explicit search/detail gates to compose inside governed reads.
- `scripts/scaffolding/action/scaffold.mts` — generated Actions must declare legal-entity scope and owner-local services.
- `scripts/scaffolding/governed-contribution/scaffold.mts` — generated module APIs/search/reports must use the read runtime and trusted identity boundary.
- `scripts/check-module-entrypoint-boundaries.mts` — existing structured entrypoint and private-loading checks.
- `scripts/check-ultramodern-api-boundaries.mts` — existing BFF boundary checker to keep transport adapters free of direct DB access.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — disposable generator output, compile, overwrite, traversal, and atomicity coverage.
- `packages/core-runtime/tests/unit/action-runtime.test.ts` — existing Action transaction and lifecycle harness.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — live Action transaction/evidence coverage.
- `packages/core-runtime/tests/integration/legal-entity-context.test.ts` — existing cross-tenant legal-entity lookup proof.
- `packages/core-runtime/tests/integration/context-access.test.ts` — existing tenant/entity-qualified SpiceDB proof.
- `apps/shell-super-app/tests/unit/shell-resources.test.ts` — current Shell search/detail authorization ordering.
- `specs/feature-complete-shell-runtime-composition.md` — records the currently deferred read-evidence and cross-tenant resource tests.

### New Files

- `docs/architecture/DATA_ACCESS.md` — authoritative governed-read, operation-scope, scoped-repository, RLS, and evidence contract.
- `packages/core-runtime/src/operations/context.ts` — internal immutable OperationalScope model and required/optional/forbidden legal-entity resolution.
- `packages/core-runtime/src/operations/errors.ts` — closed typed context/isolation failure vocabulary.
- `packages/core-runtime/src/db/scoped-transaction.ts` — private transaction-local setting and opaque repository-factory capability.
- `packages/core-runtime/src/reads/definition.ts` — typed read descriptor, registration, evidence policy, and private handler/service storage.
- `packages/core-runtime/src/reads/context.ts` — handler-facing read context containing only validated scope and owner-local services.
- `packages/core-runtime/src/reads/errors.ts` — typed read validation, denial, policy, persistence, and unavailable errors.
- `packages/core-runtime/src/reads/repository.ts` — standalone allowed/denied data-access evidence persistence.
- `packages/core-runtime/src/reads/runtime.ts` — Core-owned governed read lifecycle.
- `packages/core-runtime/tests/unit/operation-context.test.ts` — operation scope classification and fail-closed tests.
- `packages/core-runtime/tests/unit/scoped-transaction.test.ts` — transaction-local setting and capability-surface tests.
- `packages/core-runtime/tests/unit/read-definition.test.ts` — read declaration/registration invariants.
- `packages/core-runtime/tests/unit/read-runtime.test.ts` — read gate, handler, result, and evidence lifecycle tests.
- `packages/core-runtime/tests/integration/tenant-isolation.test.ts` — live least-privilege/RLS and composite-FK leakage regression suite.
- `packages/core-runtime/tests/integration/read-runtime.test.ts` — live allowed/denied read evidence and rollback behavior.
- `scripts/check-database-access-boundaries.mts` — rejects direct database/Drizzle access from generated Actions, read handlers, and BFF transport adapters.
- `scripts/tests/database-access-boundaries.test.mts` — checker fixtures for allowed owner repositories and rejected bypasses.
- `scripts/postgres/bootstrap-runtime-role.mts` — idempotent local/test provisioning of the non-superuser runtime role using the admin connection.

## Implementation Plan

### Phase 1: Foundation

Document and encode the two-dimensional operation scope: existing entrypoint `tenant`/`system`
scope plus explicit legal-entity `required`/`optional`/`forbidden` scope. Introduce a Core-owned
context validator that turns an authenticated assertion/session principal into immutable
OperationalScope only after exact persisted tenant/principal/legal-entity checks and SpiceDB access.
Add composite same-tenant constraints to Core and separate runtime database credentials from
admin/migration credentials so later RLS tests cannot pass through a superuser bypass.

### Phase 2: Core Implementation

Remove the raw Drizzle executor from handlers. Store each owner-local service factory privately in
its Action/read registration and invoke it only within a Core transaction after transaction-local
scope is installed. Add reusable Drizzle RLS helpers and catalog verification for owner business
tables. Implement the governed read runtime and extend `data_access_events` so allowed and definite
denied reads have durable, sanitized evidence independent of Action invocations.

### Phase 3: Integration

Update Codesmith before changing generated business artifacts. Generated Actions explicitly choose
legal-entity scope and use scoped services. Generated module API/search/report BFFs remove identity
from payloads, verify the existing audience-scoped Shell assertion, and call the Core read runtime.
Compose current Shell search/detail orchestration through that runtime, while keeping media
attachment unavailable until it is backed by a generated Action. Add boundary checks, live leakage
tests, and repository quality gates.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Make the isolation contract authoritative

- [x] Add `docs/architecture/DATA_ACCESS.md` defining OperationalScope ownership, legal-entity scope semantics, exact read lifecycle ordering, allowed/denied evidence, scoped service factories, RLS settings, runtime/admin role separation, same-tenant constraints, and system/background exceptions.
- [x] Update `AGENTS.md`, `README.md`, `docs/architecture/ACTIONS.md`, `docs/architecture/DATABASE.md`, `docs/architecture/MICROVERTICALS.md`, `docs/architecture/MODULE_ENTRYPOINTS.md`, and `docs/architecture/ERRORS.md` to link the new contract and state that business handlers never receive/import a database executor.
- [x] Record that tenant entrypoint scope does not imply legal-entity scope, that all descriptors choose `required`, `optional`, or `forbidden` explicitly, and that an omitted/malformed/indeterminate context fails closed before private handler resolution.
- [x] Document the deliberate RLS boundary: tenant/legal-entity business tables are RLS-protected; Core global scheduling/catalog infrastructure remains Core-private and uses composite tenant constraints rather than a business-handler RLS surface.

### 2. Split administrative and runtime PostgreSQL identities

- [x] Add `DATABASE_ADMIN_URL` to `.env.example` for role/schema/migration operations while retaining `DATABASE_URL` as the application runtime connection; update typed config tests without reading a real `.env`.
- [x] Add `scripts/postgres/bootstrap-runtime-role.mts` and package scripts to create/update an `ontos_runtime` role idempotently through `DATABASE_ADMIN_URL`, grant only required schema/table/sequence privileges, and explicitly assert `rolsuper = false` and `rolbypassrls = false`.
- [x] Update `docker-compose.yml` and local setup documentation so a fresh database provisions the admin identity plus runtime identity; document the explicit bootstrap command required for an existing persistent volume.
- [x] Update Core/Auth Drizzle migration configurations to use the admin URL, while Core/Auth application pools continue to use the runtime URL. Add unit tests for missing, malformed, or accidentally identical/superuser-compatible role configuration.

### 3. Enforce same-tenant relationships in the Core schema

- [x] Add composite unique keys such as `(tenant_id, legal_entity_id)`, `(tenant_id, principal_id)`, `(tenant_id, principal_auth_binding_id)`, and `(tenant_id, action_invocation_id)` to their parent tables in `packages/core-runtime/src/db/schema.ts`.
- [x] Replace independent foreign keys with composite tenant-qualified foreign keys wherever Core rows reference legal entities, principals, auth bindings, Action invocations, audit events, data-access events, domain events, evidence, media, module-state history, outbox, or checkpoints. Preserve nullability semantics for optional references.
- [x] Extend `data_access_events` with typed `outcome`, `outcome_stage`, and stable `outcome_code` columns suitable for allowed, denied, and failed governed reads; keep `action_invocation_id` optional for standalone reads and do not require payload evidence.
- [x] Run `mise exec -- pnpm db:generate` from `app/`, inspect the generated migration, and add only the narrow reviewed SQL that Drizzle cannot express. Do not hand-author an alternative migration.
- [x] Extend schema contract/unit tests and `packages/core-runtime/scripts/verify-db-schema.mts` to prove every declared composite constraint exists and that cross-tenant legal-entity/principal/action references are rejected by PostgreSQL.

### 4. Add Core-owned OperationalScope validation

- [x] Implement `packages/core-runtime/src/operations/context.ts` and `errors.ts` with an immutable internal scope containing trusted auth metadata, tenant, principal, optional legal entity, correlation, and trace fields; do not persist it as generic JSON or export it through browser-safe contracts.
- [x] Reuse `LegalEntityContext` and `ContextAccess`, and add the minimum exact Core query needed to recheck that tenant and principal are active, optional auth binding belongs to the same tenant/principal and remains active, and selected legal entity is active and belongs to the tenant.
- [x] Apply `required`, `optional`, and `forbidden` legal-entity semantics before module-state, Action/read permission, Policy, or handler resolution. Map definite absence/mismatch/access denial separately from database or SpiceDB uncertainty and sanitize every public reason.
- [x] Add unit and live integration tests covering missing context, stale/disabled principal, suspended tenant/entity, cross-tenant entity, cross-tenant auth binding, unauthorized entity, conditional permission, SpiceDB outage, and valid Shell/session and gateway contexts.

### 5. Replace raw Action transaction access with owner-local scoped services

- [x] Extend `ActionDescriptor` with explicit legal-entity scope and extend private Action registration state with a typed owner-local service factory. Keep the factory and handler out of public manifests and serialized contracts.
- [x] Change `ActionHandlerContext` to expose immutable validated scope, Action identity, collector methods, and the typed services returned by the registration factory; remove `ActionTransactionExecutor`, `restrictTransactionExecutor`, and `context.transaction` from the public handler surface.
- [x] Inside `ActionRuntime`, validate OperationalScope before the module snapshot, install the transaction-local database scope before locked rechecks, create owner services inside that transaction, and invoke the handler only with those services. Never accept a service object built over a global pool.
- [x] Migrate `core.modules.change-tenant-module-state` to a Core-private transaction-scoped service and mark its legal-entity scope `forbidden`; preserve its current Action lifecycle, idempotency, event, audit, and rollback behavior.
- [x] Remove or internalize root exports for `CoreDatabase`, `CoreDatabaseExecutor`, `CoreTransaction`, and scoped transaction constructors where external server composition does not require them. Add compile-time/public-surface tests proving an Action handler cannot access commit, rollback, raw CRUD, a pool, or a global database service.
- [x] Update Action unit/integration tests beside each runtime change, including a regression whose malicious handler attempts to obtain an unscoped database capability and never reaches domain data.

### 6. Add the transaction-local RLS capability and policies

- [x] Implement `packages/core-runtime/src/db/scoped-transaction.ts` so Core sets `ontos.tenant_id` and, when validated, `ontos.legal_entity_id` using parameterized transaction-local `set_config` before constructing owner services. Verify values from the same transaction and fail closed on missing/mismatched settings.
- [x] Provide reusable owner-schema helpers using Drizzle `pgPolicy` and `enableRLS` for tenant-only and tenant-plus-legal-entity tables. Policies must apply to `SELECT`, `INSERT`, `UPDATE`, and `DELETE`, use both `USING` and `WITH CHECK` where applicable, and treat missing settings as no access.
- [x] Require `FORCE ROW LEVEL SECURITY` for governed business tables. If Drizzle Kit 0.31.10 cannot emit `FORCE`, keep the typed policy in the schema and add one documented generated-migration amendment with a focused verification test.
- [x] Extend database verification so every registered governed business table has RLS enabled and forced, exact expected policies, tenant columns, and legal-entity columns when declared. Reject a runtime connection whose role is superuser or has `BYPASSRLS`.
- [x] In `tenant-isolation.test.ts`, create a temporary owner schema/table under the admin connection, exercise it through the runtime role, and prove missing scope sees zero rows, tenant A cannot select/update/delete tenant B, tenant A cannot insert tenant B, entity A cannot access entity B, transaction scope does not leak through the pool, and rollback clears settings.

### 7. Enforce database access boundaries statically

- [x] Add `scripts/check-database-access-boundaries.mts` and its tests. Reject Drizzle, `pg`, Core database, owner database client, private schema, raw scoped executor, and transaction imports from `src/actions/**`, generated read handlers, and BFF transport adapters; allow them only in owner-local DB/repository/service factories and Core infrastructure.
- [x] Detect database capabilities hidden in Action/read Effect requirements or imported through package root re-exports. Reject private cross-owner schema/repository imports consistently with `docs/architecture/DATABASE.md`.
- [x] Wire the checker into `package.json` and `mise exec -- pnpm check`. Keep diagnostics deterministic and include disposable allowed/rejected fixture tests.

### 8. Implement the governed Core read runtime

- [x] Implement `packages/core-runtime/src/reads/definition.ts`, `context.ts`, and `errors.ts`. A read descriptor must declare input/result schemas, owning module, structured read/historical-read entrypoint, legal-entity scope, permission target strategy, ordered Policy references, access kind, and evidence policy.
- [x] Store the read handler and owner service factory privately as with Actions. Handler input receives decoded request data, validated scope, and typed scoped services; it receives no browser-supplied identity, database executor, evidence repository, or transaction controls.
- [x] Implement `reads/runtime.ts` with this order: decode input; verify/revalidate OperationalScope; acquire one module-state snapshot; check module state; check legal-entity/module/resource permission; evaluate Policies; open a scoped read transaction; create owner services; execute the handler; decode the result; build evidence from the descriptor and bounded handler metadata; persist evidence; then return the result.
- [x] Implement `reads/repository.ts` so definite authorization/Policy denials persist sanitized outcome evidence without running the handler, allowed reads persist evidence before results are released, and persistence failure returns typed unavailability rather than an unaudited result. Do not persist raw query text, result rows, authorization internals, or provider diagnostics.
- [x] Define exact retry/HTTP guidance: missing or unusable authentication is `401`, definite permission denial is `403`, semantic Policy denial uses its declared `409`/`422` mapping, unavailable context/authz/evidence is retryable `503`, and unexpected defects become sanitized declared `500` at the owner BFF.
- [x] Add unit and integration tests alongside the runtime for detail/list/search/report/export/download, zero-result success, metadata-only evidence, hash-only evidence, forbidden results, Policy denial, unavailable permission, invalid result schema, handler defect, evidence write failure, and no handler execution before all gates pass.

### 9. Update Codesmith before generated business integrations

- [x] Extend the Action CLI/generator first so every generated MicroVertical Action requires `--legal-entity-scope <required|optional|forbidden>` and every Core Action emits an explicit supported scope. Update help, config typing, renderers, manifest/registration patching, disposable compile, overwrite, traversal, and no-partial-write tests.
- [x] Extend the existing `module-api`, `search-provider`, and `report` generators before creating or modifying generated read implementations. Emit a private read registration/service factory and owner BFF adapter that calls Core read runtime; do not introduce a hand-authored generic read artifact.
- [x] Remove `tenantId`, `legalEntityId`, and `principalId` from generated public provider payload schemas. Generalize the existing MicroVertical Action identity boundary into one operation identity verifier/acquisition adapter, or add an approved Codesmith operation-boundary generator before emitting read handlers; preserve exact audience, issuer, signature, time, and schema checks.
- [x] Update module contract/runtime registration slots and boundary checks so read descriptors remain public metadata, while read handlers, service factories, repositories, and executable Policies remain owner-local and lazy.
- [x] Run generator tests after each renderer change and prove regenerated output compiles without manual wiring.

### 10. Route current Shell reads through CoreSDK

- [x] Wrap Shell composition, search, resource detail, and timeline operations in owner-specific governed read registrations while retaining their current batched module/resource authorization and fail-closed provider ordering.
- [x] Derive trusted scope only from `AuthenticationService.resolveShellContext`; never accept browser tenant/legal-entity/principal headers or payload fields. Revalidate stale saved context through the shared OperationalScope resolver before provider execution.
- [x] Make the Shell-to-MicroVertical gateway acquire a fresh audience-scoped assertion for every provider attempt. The receiving owner BFF independently verifies it, runs its own Core read runtime, and scopes its repository transaction; a Shell decision is never sufficient authorization for the receiving deployment.
- [x] Record Shell orchestration evidence and owner read evidence at their respective trust boundaries without duplicating raw results. Mark partial search/provider failure safely and never include query text or result payloads in logs/evidence.
- [x] Keep `attachMedia` outside the read runtime. It must remain unavailable until a generated owner Action/API binding performs the mutation through ActionRuntime.
- [x] Complete the deferred cross-tenant/entity, denied evidence, stale context, malformed provider, and provider-before/after-authorization tests in `specs/feature-complete-shell-runtime-composition.md` without weakening its existing UI behavior.

### 11. Prove isolation end to end

- [ ] Add a generated disposable MicroVertical fixture in tests with tenant-only and legal-entity-owned tables, owner-local repositories, one Action, and detail/list/search reads. Generate the artifact wiring through Codesmith; keep the fixture temporary rather than adding a fake production vertical.
- [ ] Seed two tenants, two legal entities per tenant, colliding resource IDs, distinct principals/bindings, and exact SpiceDB grants. Verify valid same-scope reads/writes and explicit cross-tenant/cross-entity attempts through Shell, gateway assertion, receiving CoreSDK, owner repository, and PostgreSQL RLS.
- [ ] Include malicious/buggy repository cases that omit predicates or attempt to insert another tenant/entity. The scoped service test must catch the API bypass where possible and PostgreSQL must reject/filter the query even when the predicate is absent.
- [ ] Verify authorization denial and uncertainty invoke no private handler, denied reads write only safe evidence, allowed reads cannot return without evidence, failed writes leave no canonical cross-tenant state, pooled connections do not retain scope, and Core logs/Problem Details contain no foreign identifiers or database/SpiceDB diagnostics.

### 12. Run all validation gates

- [ ] Execute every command in `Validation Commands` from `app/`, inspect generated migrations and public exports, confirm `git status --short` contains only intended `app/` changes, and resolve every failure without modifying `mvp/` or `mvp2/`.

## Testing Strategy

### Unit Tests

Test legal-entity scope declarations, OperationalScope classification, stale and mismatched context,
typed error sanitization, private registration storage, absence of raw transaction methods, RLS
setting construction, read lifecycle ordering, Policy/permission fail-closed behavior, evidence
materialization, result decoding, generator output, and static database-boundary diagnostics. Existing
Shell legal-entity selection tests remain and should prove that the new shared validator does not
change one/many/zero selection behavior.

### Integration Tests

Use live PostgreSQL and SpiceDB. Connect migrations/fixtures with the admin identity and exercise
application paths with the least-privilege runtime identity. Prove composite same-tenant foreign
keys, forced RLS, transaction-local scope reset, Action rollback/commit, standalone read evidence,
definite denial evidence, assertion verification, receiving-deployment reauthorization, and
cross-tenant/entity isolation with colliding resource IDs. Complete the current Shell integration
tests with a generated disposable owner fixture; no production demo vertical is required.

### Edge Cases

- A tenant-scoped operation receives no tenant, an inactive tenant, or a principal from another tenant.
- Legal-entity scope is required but absent, forbidden but present, optional and absent, or optional and stale.
- A legal entity exists under another tenant, is inactive, or loses SpiceDB access after session selection.
- An auth binding is missing, revoked, or belongs to a different tenant/principal.
- PostgreSQL transaction settings are missing, malformed, changed inside a repository, rolled back, or reused through a pooled connection.
- The runtime database role is a superuser, owns `BYPASSRLS`, or lacks required grants.
- Tenant and legal-entity IDs collide with resource IDs or other encoded SpiceDB object components.
- A handler/service tries to import a global database, raw Drizzle transaction, another owner schema, or Core evidence repository.
- A buggy repository omits every tenant predicate or attempts a cross-tenant insert/update.
- A read returns zero results, an invalid result shape, partial provider results, or succeeds while evidence persistence fails.
- Permission is denied, conditional, malformed, slow, or unavailable; Policy denies or defects.
- An audience-scoped gateway assertion is missing, expired, tampered, replayed to another app ID, or contains stale context.
- Standalone read evidence has no Action invocation; write-internal governed reads remain linked to their Action.
- A Core system/background capability legitimately scans tenants but is not reachable through a business handler capability.

## Acceptance Criteria

- [x] Every Action and governed read explicitly declares legal-entity scope as required, optional, or forbidden; there is no implicit default in public definitions.
- [x] CoreSDK authoritatively revalidates active tenant/principal/legal-entity relationships and legal-entity permission before resolving private handlers.
- [x] Browser/business payload fields and raw identity headers cannot establish tenant, principal, or legal-entity context.
- [x] Action and read handlers expose no raw Drizzle CRUD, transaction creation, commit/rollback, pool, global DB service, Core evidence repository, or another owner's schema/repository.
- [x] Owner-local services are constructed inside the Core-owned transaction after transaction-local scope is installed.
- [x] Tenant/legal-entity business tables use enabled and forced RLS under a non-superuser, non-`BYPASSRLS` runtime role, with missing scope denying access.
- [x] PostgreSQL rejects same-tenant invariant violations for Core references even if application validation is bypassed.
- [x] A handler/repository that omits tenant/legal-entity predicates cannot read, update, delete, or insert outside OperationalScope.
- [x] Public reads, lists, searches, reports, exports, and downloads have a reusable CoreSDK lifecycle and never return an allowed result without durable evidence.
- [x] Definite read authorization/Policy denials record sanitized outcome evidence and never invoke owner handlers; indeterminate checks fail closed and retryably.
- [x] Generated provider contracts contain business input only; receiving BFFs derive context from verified audience-scoped assertions and independently reauthorize.
- [x] Static boundary checks reject direct database bypasses from Actions, read handlers, BFFs, and cross-owner code.
- [ ] Tests explicitly prove cross-tenant and cross-legal-entity isolation through one disposable generated-owner path, including pooled-connection reuse and colliding resource IDs.
- [x] Existing Action lifecycle, module-state gates, SpiceDB permission/Policy semantics, Domain Events, Outbox Messages, strict Effect errors, and MicroVertical deployment seams remain intact.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm exec node --test scripts/tests/database-access-boundaries.test.mts scripts/scaffolding/tests/scaffold-generators.test.mts` — Validate database boundary enforcement and all affected Codesmith generators.
- `mise exec -- pnpm --filter @app/core-runtime exec node --test tests/unit/operation-context.test.ts tests/unit/scoped-transaction.test.ts tests/unit/read-definition.test.ts tests/unit/read-runtime.test.ts tests/unit/action-*.test.ts` — Validate scope, scoped capabilities, governed reads, and Action regressions.
- `mise exec -- pnpm --filter @app/core-runtime exec node --test tests/integration/legal-entity-context.test.ts tests/integration/context-access.test.ts tests/integration/tenant-isolation.test.ts tests/integration/read-runtime.test.ts tests/integration/action-runtime.test.ts` — Prove live PostgreSQL/SpiceDB context, RLS, evidence, and Action isolation.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Validate Shell context, search, resource, and typed UI integration behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — Validate Shell/Auth/Core runtime composition and trusted assertion boundaries.
- `mise exec -- pnpm db:verify` — Verify final schemas, composite constraints, RLS policies, grants, and runtime role safety.
- `mise exec -- pnpm typecheck` — Validate workspace project references and generic registration/service types.
- `mise exec -- pnpm build` — Validate production application, generated client, and Module Federation boundaries.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This plan assumes the defense-in-depth choice is approved: owner-local scoped services are the primary developer API and PostgreSQL RLS is the final backstop.
- The existing Shell `activeLegalEntityId` behavior is retained: one authorized entity auto-selects, several require selection, tenant switching clears it, and every request revalidates it.
- RLS is required for tenant/legal-entity business tables. Applying RLS to Core's cross-tenant scheduler/catalog/outbox tables is deliberately out of scope because those processes require controlled global scans; business handlers lose all direct access to those capabilities instead.
- The runtime/admin role split is a deployment prerequisite, not an optional hardening task. An RLS test executed as the current Compose superuser is not accepted as proof.
- The exact PostgreSQL role names may be deployment-configurable, but tests and verification must assert capabilities rather than trusting names.
- No production MicroVertical currently exists under `verticals/`; end-to-end proof therefore uses Codesmith-generated disposable fixtures and must not introduce fake business code.
- `mvp/` and `mvp2/` remain read-only and are not implementation targets.
- The new read definition/runtime is Core infrastructure. Before it emits any owner business artifact, the existing module API/search/report generators must be extended and approved as specified above.

## Implementation Evidence

### Summary

- Made OperationalScope, explicit legal-entity scope, scoped owner services, governed reads, durable read evidence, and least-privilege PostgreSQL RLS CoreSDK invariants.
- Split administrative and runtime database identities, added composite same-tenant constraints, generated and applied the resulting Drizzle migrations, and extended live schema/role verification.
- Updated Action, module API, search, and report generators before integrating Shell reads; generated BFFs now verify audience-scoped assertions and independently invoke the Core read runtime.
- Routed Shell composition, module-target, search, resource-detail, and timeline reads through governed registrations while keeping media mutation outside the read runtime.
- Added static database-boundary enforcement plus separate generated, live PostgreSQL, and live SpiceDB tests. One disposable generated-owner integration path that composes all boundaries remains required before this spec can return to `done`.

### Changed Files

- Core runtime: `packages/core-runtime/src/{operations,reads,db,actions}/`, public runtime composition, schema verification, migrations, and unit/integration tests.
- Shell: trusted authentication/runtime composition, governed read registrations, API routing, contracts, and integration tests under `apps/shell-super-app/`.
- Codesmith and guardrails: Action/governed-contribution renderers, CLI contracts, combined disposable compilation tests, and `scripts/check-database-access-boundaries.mts`.
- Operations and documentation: `.env.example`, `docker-compose.yml`, PostgreSQL bootstrap scripts, root package scripts, and the authoritative architecture guidance.
- Final diff size: 75 files, 19,407 added lines, and 341 deleted lines (including generated Drizzle snapshots and migrations).

### Tests Added or Updated

- Generator and static-boundary suite: 25 passing tests, including combined generated Action/module API/search/report output and real-workspace compilation.
- Focused Core unit suite: 66 passing tests for OperationalScope, scoped transactions, governed-read definitions/runtime, and Action regressions.
- Live Core integration suite: 21 passing tests across PostgreSQL, SpiceDB, Action runtime, governed reads, evidence, composite foreign keys, RLS, and scope reuse.
- Shell unit suite: 101 passing tests across 18 files; Shell integration suite: 3 passing tests.

### Validation Results

- `mise exec -- pnpm exec node --test scripts/tests/database-access-boundaries.test.mts scripts/scaffolding/tests/scaffold-generators.test.mts` — passed (25/25).
- `mise exec -- pnpm --filter @app/core-runtime exec node --test tests/unit/operation-context.test.ts tests/unit/scoped-transaction.test.ts tests/unit/read-definition.test.ts tests/unit/read-runtime.test.ts tests/unit/action-*.test.ts` — passed (66/66).
- Core integration command from this plan, with explicit admin/runtime PostgreSQL and SpiceDB configuration — passed (21/21).
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed (101/101 across 18 files).
- Shell integration command from this plan, with explicit admin/runtime PostgreSQL and SpiceDB configuration — passed (3/3).
- `mise exec -- pnpm db:verify` — passed (18 Core and 4 Auth schema checks).
- `mise exec -- pnpm typecheck` — passed.
- `mise exec -- pnpm build` — passed, including production build and deployment/Module Federation/performance readiness checks.
- `mise exec -- pnpm check` — passed, including formatting, lint, Action tests, typecheck, skills, API/module/database boundaries, contracts, and performance readiness.
- `mise exec -- pnpm db:generate` was run after schema changes; generated migrations `0002` through `0005` were inspected, applied, and re-verified.

### Review Findings

- Reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, and the relevant MicroVertical, Action, error, database, module-entrypoint, module-manifest, outbox, and data-access guidance.
- Removed legacy independent business foreign keys after composite-key review, added the missing tenant-qualified auth-binding/impersonator references, and extended catalog verification to all declared composite constraints.
- Closed generator contract gaps for typed `401`, `403`, `404`, `422`, `500`, and `503` failures, including the `WWW-Authenticate: Bearer` challenge, and compiled the combined generated output.
- Kept all changes inside `app/`; no production fake MicroVertical was introduced. Cross-boundary proof composes disposable generated owner artifacts with live CoreSDK, gateway/assertion, Shell, SpiceDB, and disposable forced-RLS table tests.
- Browser validation was not applicable because this change affects server/runtime contracts and preserves the existing UI behavior; HTTP/runtime integration tests cover the changed transport boundaries.

### Deviations

- None.
