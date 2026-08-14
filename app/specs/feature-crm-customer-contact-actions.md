---
type: feature
status: done
created: 2026-08-14
---

# Feature: CRM Customer and Contact Actions and BFF

## Feature Description

Expose the existing CRM-owned Customer and Contact records through authenticated, typed Effect
operations. Add generated state-changing Actions for creating, editing, archiving, and unarchiving
both entities. Add governed reads for Customer detail/list and Contact detail/list, with the Contact
list always scoped by one Customer. Publish every operation through the CRM MicroVertical's Effect
BFF so frontend code can call a generated client method without importing backend code or using an
ad hoc HTTP request. Every successfully completed requested `Get*` operation must commit one
runtime-owned Data Access Event to `core.data_access_events` before its result is released.

The feature retains the persistence model already established in `crm.customers` and
`crm.contacts`: Customer has a required name; Contact has a required name, email, phone, and one
immutable parent Customer; both use a nullable `archived_at` lifecycle marker and tenant RLS. It
adds no UI, cross-MicroVertical dependency, Policy, additional tenant-role permission, public
Domain Event, or Outbox Message.

## User Story

As a signed-in CRM user
I want to create, edit, inspect, list, archive, and restore Customers and their Contacts
So that frontend CRM features can manage the canonical records through one typed and auditable BFF
boundary

## Problem Statement

CRM currently persists Customers and Contacts but exposes only its generated readiness endpoint.
Frontend code therefore has no supported Effect client methods for the records, and direct database,
backend-handler, or fetch access would bypass the MicroVertical, governed operation, authentication,
module-state, audit/evidence, and typed error boundaries.

The requested operation names also describe four reads as Actions. OntOS Actions are write-only and
would incorrectly make reads require idempotency/invocation records and become unavailable when the
module is `read_only` or `deprecated`. Those operations need the governed Read runtime while keeping
the requested `getCustomerDetail`, `getCustomerList`, `getContact`, and `getContactList` frontend
method names.

## Solution Statement

Run the mandatory Action generator for eight writes: create, edit, archive, and unarchive Customer,
and the same four Contact operations. Adapt the generated registrations with concrete public input
and result schemas, owner-local service factories over the Core-supplied scoped transaction, typed
domain failures, metadata-only access evidence, required idempotency, `legalEntityScope: 'optional'`,
and `policies: []`. Do not declare an additional tenant permission or provision an Action-specific
SpiceDB executor relation; the normal authenticated context, tenant/module gates, runtime
availability checks, and unconfigured-Action compatibility behavior still apply.

Generate four module APIs as the supported starting point for Customer detail/list and Contact
detail/list reads. Adapt their `defineRead` registrations to tenant-level access, optional legal-
entity context, metadata-only evidence, empty Policy lists, CRM table queries, and typed not-found or
unavailable failures. Customer and Contact lists are bounded and deterministically ordered; both
default to active records and accept an explicit active/archived/all filter. Contact list input must
contain `customerId`, verifies that the same-tenant Customer exists, returns `404` when it does not,
and returns an empty list when it exists without matching Contacts. Each read handler returns
bounded evidence metadata with the released result count, and `ReadRuntime` atomically persists the
corresponding allowed row in `core.data_access_events` in the governed read transaction. Evidence
persistence failure is a typed retryable failure and no read result may escape without its durable
record.

Compose the generated Action identity boundary, Action/Read runtimes, strict Effect HttpApi
contracts, handlers, and contract-derived clients into the existing CRM BFF. Export exactly these
frontend methods: `createCustomer`, `editCustomer`, `getCustomerDetail`, `getCustomerList`,
`archiveCustomer`, `unarchiveCustomer`, `createContact`, `editContact`, `getContact`,
`getContactList`, `archiveContact`, and `unarchiveContact`. Each mutation accepts explicit
idempotency/correlation input and obtains a fresh CRM-audience Shell assertion for each invocation.
All declared backend, transport, and decode errors stay typed in the client Effect error channel.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — repository scope and mandatory Codesmith Action generator rule.
- `AGENTS.md` — authoritative MicroVertical, Action, Effect, governed data-access, module-entrypoint, and toolchain constraints.
- `README.md` — current CRM deployment, strict Effect BFF, authentication assertion, and database-owner context.
- `package.json` — supported focused and repository-wide validation commands.
- `verticals/crm/package.json` — CRM dependencies and focused test/build scripts.
- `verticals/crm/src/db/schema.ts` — authoritative Customer/Contact fields, tenant RLS, parent foreign key, timestamps, and archive markers.
- `verticals/crm/shared/api.ts` — existing strict Effect CRM API contract to extend with mutation endpoints and shared public schemas.
- `verticals/crm/api/index.ts` — existing CRM BFF runtime composition and endpoint layer.
- `verticals/crm/src/api/crm-client.ts` — existing contract-derived frontend client surface to extend with the twelve named methods.
- `verticals/crm/vertical.manifest.ts` — generated owner manifest slots for the eight Actions and four read APIs.
- `verticals/crm/vertical.registration.ts` — generated private registrations for Actions and lazy BFF clients.
- `packages/core-runtime/src/actions/definition.ts` — typed Action descriptor, handler, and scoped service-factory contract.
- `packages/core-runtime/src/actions/runtime.ts` — canonical invocation, idempotency, authorization, transaction, evidence, and error lifecycle.
- `packages/core-runtime/src/reads/definition.ts` — governed read descriptor, permission target, evidence, handler, and service-factory contract.
- `packages/core-runtime/src/reads/runtime.ts` — canonical authenticated read, module gate, permission, transaction, evidence, and result lifecycle.
- `packages/core-runtime/src/reads/repository.ts` — runtime-owned persistence of governed read evidence into `core.data_access_events`.
- `packages/core-runtime/src/db/schema.ts` — authoritative Data Access Event table and nullable Action-invocation association.
- `packages/core-runtime/src/runtime-infrastructure.ts` — Core persistence layer required by CRM Action and Read runtimes without exposing an executor to handlers.
- `scripts/scaffolding/action/scaffold.mts` — mandatory Action starting point and manifest/registration wiring.
- `scripts/scaffolding/action-service/scaffold.mts` — generated owner-local scoped persistence-service starting point for Actions.
- `scripts/scaffolding/governed-contribution/scaffold.mts` — supported module-API/read contract, server, client, and registration starting point.
- `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` — generated CRM-audience assertion verifier and frontend acquisition adapter.
- `docs/architecture/ACTIONS.md` — authoritative write lifecycle and typed Action BFF mapping.
- `docs/architecture/DATA_ACCESS.md` — optional legal-entity scope, Core-owned transactions, tenant isolation, and durable read evidence.
- `docs/architecture/ERRORS.md` — declared Problem Details status and generated client error requirements.
- `docs/architecture/MICROVERTICALS.md` — independent CRM deployment and virtual Effect BFF seam.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — read/write module-state behavior and private implementation gates.
- `docs/architecture/ULTRAMODERN.md` — Effect-first and Codesmith business-artifact rules.
- `specs/feature-crm-customer-contact-persistence.md` — completed persistence contract and deliberately deferred operation scope.

### New Files

- `verticals/crm/src/actions/{create,edit,archive,unarchive}-customer.action.ts` — generated Customer write registrations, private handlers, and scoped owner service factories.
- `verticals/crm/src/actions/{create,edit,archive,unarchive}-contact.action.ts` — generated Contact write registrations, private handlers, and scoped owner service factories.
- `verticals/crm/src/services/customer-contact-persistence.service.ts` — generated owner-local scoped persistence operations shared by the CRM Actions and Reads.
- `verticals/crm/shared/apis/{customer-detail,customer-list,contact-detail,contact-list}.ts` — generated read/BFF contracts adapted to canonical DTO, input, result, and Problem Details schemas.
- `verticals/crm/src/api/{customer-detail,customer-list,contact-detail,contact-list}.read.ts` — generated governed read registrations and owner-local scoped query services.
- `verticals/crm/src/api/{customer-detail,customer-list,contact-detail,contact-list}-client.ts` — generated Effect clients for the four reads.
- `verticals/crm/api/{customer-detail,customer-list,contact-detail,contact-list}-read-server.ts` — generated authenticated governed-read HttpApi layers.
- `verticals/crm/api/auth/action-principal.ts` — generated CRM-audience Shell assertion verifier shared by writes and reads.
- `verticals/crm/src/api/action-gateway.ts` — generated frontend adapter that obtains a fresh audience-scoped assertion for each BFF attempt.
- `verticals/crm/tests/unit/customer-contact-action-contract.test.ts` — Action schema, descriptor, manifest, and registration contract tests.
- `verticals/crm/tests/unit/customer-contact-api-contract.test.ts` — twelve-method BFF schema, route, status, and typed-client contract tests.
- `verticals/crm/tests/unit/action-principal.test.ts` — CRM assertion verification and sanitized authentication failure tests.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — live governed Action/Read behavior, tenant isolation, lifecycle, parent scope, evidence, and idempotency tests.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — in-process strict Effect BFF request/response and client error-decoding tests.

## Implementation Plan

### Phase 1: Foundation

Generate all eight state-changing Actions first, using the existing `crm.core` module contract and
optional legal-entity scope. Generate the four read module APIs next; the first module-API generator
also creates CRM's Action identity boundary because it is not currently present. Confirm every
generated artifact is patched into only the owner manifest/registration slots and no raw Shell or
cross-vertical import is introduced.

### Phase 2: Core Implementation

Define browser-safe Customer/Contact DTOs and operation inputs, then implement the eight generated
Actions and four generated Reads. Handlers receive only owner-local service methods built over the
Core-supplied scoped transaction. They use typed Drizzle table references, trusted scope tenant ID,
metadata-only evidence, deterministic pagination, and typed failures. Customer archive does not
cascade to Contacts, Contact's parent is immutable after creation, edits preserve archive state,
and archive/unarchive reject an already-achieved lifecycle state as a typed conflict. Every
successful governed read supplies an exact result count so `ReadRuntime` can durably commit its Data
Access Event before returning the Customer or Contact result.

### Phase 3: Integration

Add the mutation endpoints and all twelve named client methods to the existing CRM BFF, compose the
generated read server layers plus Action/Read runtime dependencies, and exhaustively map verification,
module-state, Action, Read, domain, persistence, and unexpected failures to declared RFC 9457
schemas. Add focused unit and live integration coverage for authenticated invocation, no custom
permissions/Policies, tenant isolation, Customer-scoped Contact listing, archive visibility,
idempotency, durable evidence, and contract-derived client decoding.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the eight state-changing Actions

- [x] From `app/`, run these mandatory Codesmith commands before authoring any Action files:
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action create-customer --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action edit-customer --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action archive-customer --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action unarchive-customer --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action create-contact --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action edit-contact --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action archive-contact --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --vertical crm --action unarchive-contact --legal-entity-scope optional`
- [x] Inspect the generated files and the sorted `vertical.manifest.ts` / `vertical.registration.ts` slots; retain the generator headers, `crm.core` ownership, tenant `action`/`write` entrypoints, `idempotency: 'required'`, `legalEntityScope: 'optional'`, metadata-only evidence, and `policies: []`.

### 2. Generate the four governed read APIs and shared identity boundary

- [x] From `app/`, run `mise exec -- pnpm scaffold:module-api -- --vertical crm --name customer-detail`, then the equivalent commands for `customer-list`, `contact-detail`, and `contact-list`; let the first generator create `api/auth/action-principal.ts` and `src/api/action-gateway.ts`, and do not recreate or fork that shared boundary.
- [x] Inspect the generated manifest/registration/API slots and keep each read as an `api`/`read` entrypoint. Replace the scaffold's placeholder response only after generation; do not convert a getter into an Action or hand-author an unregistered read artifact.

### 3. Define the public CRM operation contracts

- [x] Adapt the generated read contracts plus `verticals/crm/shared/api.ts` to define one canonical browser-safe Customer DTO (`customerId`, `name`, ISO timestamps, nullable `archivedAt`) and Contact DTO (`contactId`, `customerId`, `name`, `email`, `phone`, ISO timestamps, nullable `archivedAt`), using concrete Effect Schemas rather than persistence row types or generic JSON.
- [x] Define mutation inputs for the eight write operations. Creation accepts business fields only; edits keep `customerId` on Contact immutable; archive/unarchive accept only the target ID. Normalize required strings consistently, validate email format at the Action boundary, and keep phone validation to a trimmed non-empty value until a product-owned regional format is specified.
- [x] Define bounded list inputs (`limit` 1–100, non-negative `offset`, optional active/archived/all filter defaulting to active), deterministic list results (`items` plus nullable `nextOffset`), and require `customerId` in every Contact-list request.
- [x] Declare operation-specific RFC 9457 schemas for `400`, `401` with Bearer challenge, `403`, `404`, `409`, `428` for a missing required idempotency key, retryable `503`, and sanitized `500` only where the operation can produce them. Ensure actual response status and Problem Details `status` are identical.

### 4. Implement Customer Actions with focused tests

- [x] Adapt the four generated Customer Action files to use the shared payload/result schemas and typed Customer domain errors. In each service factory, close typed Drizzle operations over the Core-supplied transaction and trusted `scope.tenantId`; the private handler receives only create/edit/archive/unarchive service methods, never a database executor or global CRM pool.
- [x] Implement create and edit with trimmed names and authoritative `updated_at` changes. Implement archive/unarchive as nullable `archived_at` transitions that return a typed `409` conflict when the Customer is already in the requested state. Return the canonical Customer DTO and `404` when an addressed Customer is absent in the trusted tenant.
- [x] Keep Customer archive non-cascading: it must not update or delete Contact rows. Keep edits independent of archive status and preserve the current archive marker. Declare no Domain Event or Outbox Message in this increment; successful Action audit and access evidence remain mandatory.
- [x] Add unit contract tests proving exact Action keys, owner, entrypoints, legal-entity scope, idempotency, empty Policies, absent additional tenant permission, declared schemas/errors, manifest identity, and private registration identity.

### 5. Implement Contact Actions with focused tests

- [x] Adapt the four generated Contact Action files to use the shared schemas and typed Contact domain errors, with owner-local service closures over the Core transaction and trusted tenant scope.
- [x] Implement create with an existing same-tenant Customer lookup, immutable `customerId`, normalized name/email/phone, and Data Access evidence for the parent invariant read. Return `404` for an absent parent without leaking cross-tenant existence; preserve the database composite foreign key as the race-safe invariant.
- [x] Implement edit for name/email/phone only, preserving parent and archive marker. Implement archive/unarchive as nullable `archived_at` transitions with typed already-archived/already-active `409` conflicts. Return the canonical Contact DTO and `404` for a missing tenant-local Contact.
- [x] Extend unit contract tests for exact Contact Action descriptors, parent immutability, field validation, declared failures, manifest/registration wiring, and the correction from the requested typo `EditCContactAction` to `EditContactAction`.

### 6. Implement governed Customer and Contact reads

- [x] Adapt `customer-detail.read.ts` and `customer-list.read.ts` with `accessKind: 'detail'` / `'list'`, `legalEntityScope: 'optional'`, tenant permission target using the baseline tenant access check, metadata-only evidence, `policies: []`, and owner-local typed Drizzle services. Detail returns active or archived records; list applies the explicit archive filter, orders by name then Customer ID, fetches at most `limit + 1`, and calculates `nextOffset` without an unbounded count query.
- [x] Adapt `contact-detail.read.ts` and `contact-list.read.ts` equivalently. Contact detail resolves by Contact ID. Contact list must first verify the requested Customer in the trusted tenant, record that invariant read, filter every Contact query by both tenant scope and `customerId`, order by name then Contact ID, and never return Contacts belonging to another Customer.
- [x] Return typed read-not-found for absent detail targets and an absent Contact-list parent, typed unavailable for persistence failure, an empty successful list for an existing Customer without matching Contacts, and bounded evidence with the released result count.
- [x] Rely on `ReadRuntime`—not the CRM handler or repository—to write one allowed Data Access Event to `core.data_access_events` in the same governed transaction before releasing each successful `getCustomerDetail`, `getCustomerList`, `getContact`, or `getContactList` result. Detail evidence has `access_kind = 'read'` and `result_count = 1`; list evidence has `access_kind = 'list'` and the exact number of returned items, including `0` for an empty list. The standalone read record has `action_invocation_id = null`, uses the operation's stable evidence policy/read key and trusted tenant/principal context, and contains no raw query or returned CRM data.
- [x] Add unit tests for read descriptors, archive filtering, stable pagination, required Contact-list `customerId`, no cross-Customer fallback, empty result semantics, exact evidence metadata, and absence of Policies or a legal-entity-owned data assumption.

### 7. Integrate all operations into the strict Effect BFF

- [x] Extend `verticals/crm/shared/api.ts` and `api/index.ts` with the eight mutation endpoints, and merge the four generated read APIs/server layers into the CRM runtime. Provide `ActionRuntimeLive` and `makeReadRuntimeLive(...)` with `CorePersistenceLive` and the existing Core authorization/module-state layers; do not run CRM queries through `CrmDatabaseLive` or open a second transaction inside a governed operation.
- [x] Verify the Bearer assertion with the generated CRM-audience verifier before Action/Read runtime entry. Pass business payload, trusted principal, correlation/trace metadata, and idempotency key separately so browser input can never override tenant, principal, binding, or legal-entity context.
- [x] Exhaustively map assertion errors, full `ActionCoreError` / `ReadCoreError` unions, operation domain errors, and caught defects to only declared Problem Details schemas. Missing/invalid/expired assertions are `401` with `WWW-Authenticate: Bearer`; module or definite permission denial is `403`; absent CRM records are `404`; lifecycle/idempotency conflicts are `409`; missing idempotency is `428`; infrastructure/authorization uncertainty is retryable `503`; unexpected defects are logged with safe correlation context and returned as sanitized `500`.
- [x] Extend `src/api/crm-client.ts` and the generated read clients to export the exact twelve requested method names. Mutation methods must require an idempotency key, accept correlation options, use `actionGateway` to acquire a fresh assertion per attempt, and retain declared backend, transport, and decode failures in their Effect error channels. Do not add `fetch`, Promise-only wrappers, or backend imports to frontend code.

### 8. Prove governed behavior and BFF decoding

- [x] Add live integration fixtures for active tenant/module/principal context and exercise the eight Actions through `ActionRuntime`: successful CRUD/lifecycle transitions, same-key replay without duplicate writes, conflicting request hash, missing key, archived-state conflict, no Action-specific permission/Policy requirement, correct audit/data-access evidence, and transaction rollback on typed failure.
- [x] Exercise the four Reads through `ReadRuntime`: Customer detail/list, Contact detail, Customer-scoped Contact list, active/archived/all filtering, pagination, empty list, missing parent/detail, module `read_only` readability, and tenant/cross-Customer isolation. Measure the evidence-row count before and after every successful read, query `core.data_access_events` by tenant and stable evidence policy key, and prove the call adds exactly one committed allowed record before the caller observes the result, with the correct `access_kind`, `result_count`, serving module, target metadata, principal/auth context, and null `action_invocation_id`. Prove an empty list records `result_count = 0`, and force evidence persistence failure to prove the BFF returns typed retryable `503` without releasing the read result.
- [x] Test the strict Effect BFF and contract-derived clients in process for all twelve methods, including valid signed-in calls, missing/invalid assertion, declared status/error decoding, Bearer challenge, retryable unavailability, idempotency propagation, and sanitized unexpected failure. Verify no route or UI is added.

### 9. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without adding UI, Policies, permission provisioning, cascade archive behavior, Contact reassignment, Domain Events, Outbox Messages, or unrelated CRM fields.

## Testing Strategy

### Unit Tests

Test all Action and Read descriptors, payload/result/DTO schemas, validation and normalization,
archive filter/pagination helpers, typed domain failures, no custom Policy/permission declaration,
manifest and private registration identity, assertion verification, Problem Details statuses, exact
BFF method names, exact read evidence metadata, and contract-derived Effect error types. Keep
presentation/browser tests out of scope because the feature adds no UI.

### Integration Tests

Use the migrated Core and CRM PostgreSQL schemas with deterministic tenant/principal/module fixtures.
Run writes through the real Action runtime and reads through the real Read runtime so transaction
scope, forced RLS, module-state semantics, idempotency, audit/read evidence, parent integrity, and
tenant isolation are exercised rather than bypassed with direct repository calls. Run the strict
Effect BFF in process with signed and invalid assertions and call it through the generated clients
to prove request metadata and declared errors survive the complete horizontal seam. Inspect
`core.data_access_events` after every successful requested `Get*` call and simulate evidence-storage
failure to prove that durable read evidence is a prerequisite for releasing a result.

### Edge Cases

- A Customer name or Contact name/email/phone is empty or padded; email is malformed.
- A Contact creation references a missing or cross-tenant Customer.
- A Contact edit attempts to change its parent Customer.
- Customer archive leaves all Contact rows and their independent archive states unchanged.
- Archive is requested for an archived record or unarchive for an active record.
- An archived record is fetched directly, omitted from the default active list, and included only by the matching archived/all filter.
- A Customer exists without Contacts, versus the requested Customer itself not existing.
- An empty Customer or Contact list still commits an allowed Data Access Event with `result_count = 0`.
- Data Access Event persistence fails after the handler produced a result; the transaction rolls back and the result is not released.
- Contact pages contain records for multiple Customers with equal names or equal Contact field values.
- Pagination has zero, exactly `limit`, and more than `limit` matching rows with stable tie-breaking IDs.
- The same idempotency key is replayed with the same payload or reused with a different payload.
- Authentication is missing, malformed, expired, wrong-audience, or temporarily unverifiable.
- CRM is active, `read_only`, inactive, or its module-state check is unavailable.
- Persistence, evidence, SpiceDB, or module-state capability is unavailable or indeterminate.
- A second tenant guesses a valid Customer or Contact UUID and receives no leaked record.

## Acceptance Criteria

- [x] Eight generated state-changing Actions exist with exact keys under `crm.core`, required idempotency, optional legal-entity scope, metadata-only evidence, empty Policy arrays, and no additional tenant permission.
- [x] The four requested getters are governed Reads, not write Actions, while the frontend exports the requested `getCustomerDetail`, `getCustomerList`, `getContact`, and `getContactList` names.
- [x] `EditCContactAction` is implemented as the correctly named `EditContactAction` / `editContact` operation.
- [x] Customer and Contact creation, editing, archiving, and unarchiving use the existing typed CRM tables in one Core-owned governed transaction and never expose a database executor to a handler.
- [x] Contact always belongs to exactly one immutable Customer, and every Contact-list request requires and enforces one Customer ID.
- [x] Customer archive does not cascade to Contacts; archive/unarchive are non-destructive and already-achieved transitions return a typed conflict.
- [x] Customer/Contact detail returns active or archived records; lists are bounded, stable, active by default, and support explicit archived/all filtering.
- [x] All twelve operations are callable through named contract-derived Effect BFF client methods with no ad hoc fetch or backend import.
- [x] A missing or unusable signed-in assertion returns declared `401` Problem Details with a Bearer challenge; all other expected failures use declared, semantically correct statuses and typed client errors.
- [x] Reads remain available under module `read_only` / `deprecated` semantics while writes remain denied by the canonical module-state matrix.
- [x] Every successful `getCustomerDetail`, `getCustomerList`, `getContact`, and `getContactList` call commits exactly one new allowed row to `core.data_access_events` before returning, with the correct read/list access kind and result count, trusted context, stable evidence identity, and no Action invocation association.
- [x] A Data Access Event persistence failure prevents the corresponding `Get*` result from being returned and is exposed as the declared retryable unavailable error.
- [x] Action idempotency, audit/access evidence, read evidence, tenant RLS, parent integrity, and cross-tenant/cross-Customer isolation are proven by tests.
- [x] No UI, permission provisioning, Policy, Contact reassignment, cascade archive, new CRM field, public Domain Event, Outbox Message, cross-vertical import, or unrelated feature is introduced.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate Action/Read descriptors, schemas, auth boundary, BFF contract, and generated client surface.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate live governed operations, BFF behavior, idempotency, evidence, RLS, lifecycle, and parent scope.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate the CRM Action, Read, server-layer, and client Effect types.
- `mise exec -- pnpm api:check` — enforce the strict Effect HttpApi/client topology and declared schemas.
- `mise exec -- pnpm database-access:check` — ensure handlers receive only scoped owner services and no CRM/global executor escapes.
- `mise exec -- pnpm module-entrypoints:check` — validate generated Action/API entrypoints, private bindings, and no raw private loads.
- `mise exec -- pnpm check:module-contracts` — validate the CRM manifest, registration, and serialized contract.
- `mise exec -- pnpm --filter @app/crm build` — compile the independently deployable CRM BFF and frontend client artifacts.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Validation Evidence

- CRM unit tests: 20 passed.
- CRM integration tests: 3 passed against the isolated PostgreSQL database.
- CRM typecheck, API/database/module-entrypoint/module-contract/UltraModern guards: passed.
- Codesmith generator suite: 33 passed, including the generated Action-service and boundary regressions.
- Repository-wide `mise exec -- pnpm check`: passed.
- CRM production build: passed with the fixed source revision supplied for the dirty worktree build.
- Independent spec-correctness review: clean.
- Independent architecture and standards review: clean.

## Notes

- The request is one cohesive feature because all twelve operations share the same CRM persistence,
  authenticated BFF, runtime layers, public DTOs, error vocabulary, and integration tests.
- `GetCustomerDetailAction`, `GetCustomerListAction`, `GetContactAction`, and
  `GetContactListAction` are interpreted as requested operation/client names. Authoritative OntOS
  guidance requires them to be governed Reads, not Actions. This is not an unresolved developer
  decision.
- `EditCContactAction` is treated as a typographical error for `EditContactAction`.
- Customer and Contact are tenant-wide records in the completed persistence feature, so all new
  operations use `legalEntityScope: 'optional'`: a selected legal entity is revalidated when present
  but is not persisted as record ownership.
- "No permission nor policy restrictions" means no Action-specific executor provisioning, no
  additional tenant-role permission, and `policies: []`. Mandatory authentication, trusted-context
  validation, tenant/module state gates, tenant baseline access for Reads, RLS, fail-closed
  infrastructure checks, and Action runtime compatibility behavior are not bypassed.
- The requested `Get*` Data Access record is the governed `ReadRuntime` evidence row in
  `core.data_access_events`, not a CRM-owned log table and not an Action Invocation Log. Successful
  detail/list results persist allowed evidence atomically before release; definite authorization or
  Policy denials retain the runtime's separate sanitized denied-evidence behavior.
- List defaults and archive semantics are conservative: active-only by default, explicit historical
  filtering, non-cascading Customer archive, immutable Contact parent, and edits that preserve but
  are not blocked by archive state.
- No unresolved decision blocks implementation.

## Implementation Evidence

- Implemented in worktree
  `/Users/jiprochazka/Projects/Programming/TechsioCZ/ontos-feature-crm-customer-contact-actions`
  on branch `codex/feature-crm-customer-contact-actions`, based on
  `d1818d84db23c1ddcb4e3ca8214b3daf1d74be61`.
- Ran the mandatory Codesmith generators from `app/` for the eight Customer/Contact Actions and the
  four Customer/Contact module APIs before adapting their generated output. Generated source headers
  and manifest/registration slots were retained.
- Added the twelve typed CRM operations, strict authenticated BFF handlers, governed Action/Read
  runtime composition, contract-derived frontend clients, canonical DTOs, typed Problem Details,
  tenant-scoped persistence services, stable pagination, lifecycle conflicts, idempotency, and
  durable read evidence.
- Added 19 focused unit tests and 3 PostgreSQL-backed integration tests. The live governed-runtime
  test exercises all eight mutations, all four read registrations, idempotent replay, missing
  idempotency, lifecycle filtering, and committed standalone read evidence.
- Passed `test:unit`, `test:integration`, CRM `typecheck`, `api:check`,
  `database-access:check`, `module-entrypoints:check`, `check:module-contracts`, CRM `build`, the
  scaffold boundary tests, `contract:check`, and the repository-wide `pnpm check` quality gate.
  The CRM build used the explicit base revision because the release-envelope check intentionally
  rejects a dirty worktree revision during implementation.
- Used an isolated migrated PostgreSQL database for integration validation and removed it afterward.
  No UI, route, Policy, permission provisioning, Contact reassignment, cascade archive, Domain Event,
  Outbox Message, or cross-vertical dependency was added.
