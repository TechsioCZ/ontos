---
type: feature
status: in_progress
created: 2026-08-09
---

# Feature: Complete identity modes

## Feature Description

Complete the Shell/Core identity architecture so every identity mode documented for OntOS has a
trusted, usable runtime path. Preserve the existing Better Auth interactive session flow and add:

- human API keys;
- administrator-issued API keys bound to tenant-local `service` and `integration` principals;
- tenant-local `system` or `service` principal contexts for trusted background operations;
- tenant-local support impersonation, including writes, with the target as effective actor and the
  original support administrator retained in evidence; and
- complete backend lifecycle APIs for non-human principals, API keys, bindings, and impersonation.

External API-key callers authenticate only at the central Shell/Core gateway. Shell verifies the
raw key through Better Auth, Core resolves the stable Better Auth key ID through exactly one active
`api_key` binding, and Shell returns the existing five-minute assertion for one explicit
MicroVertical audience. The raw API key never crosses the Shell boundary.

No administration UI, Better Auth organization model, autonomous agent behavior, global
cross-tenant support identity, generic Action endpoint, or Auth MicroVertical is included.

## User Story

As an OntOS administrator or integration operator
I want human, service, integration, system, and impersonated actors to enter the same governed
operation runtime through their appropriate trusted authentication path
So that API automation, background work, and support activity are authorized and audited as the
correct effective actor without exposing credentials or weakening tenant isolation

## Problem Statement

The `develop` branch currently implements only Better Auth user sessions end to end. Core already
stores principal kinds `human`, `service`, `integration`, `agent`, and `system`; binding subject
types `user` and `api_key`; Action authentication methods `session`, `api_key`, `system`, and
`support_impersonation`; and optional binding, context-reference, and impersonator evidence fields.
Those shapes make the architecture explicit but do not authenticate or construct the non-session
modes.

The Shell Auth schema has no Better Auth API-key or Admin plugin fields. The principal resolver is
hard-coded to `subject_type = user`. Shell always creates `authMethod = session`. A manually
constructed `system` context bypasses the binding requirement, but no Core-owned factory proves the
tenant, principal kind, or job identity. Impersonation fields flow through Action/read persistence
when manually supplied, but no Better Auth impersonation session is resolved into an effective
target and original administrator.

Consequently, API-key rows and non-human principals can be seeded but cannot securely call OntOS;
system identity can be forged by trusted code that constructs a loose object; support impersonation
cannot start, stop, revalidate, or audit; and principal/key lifecycle would require direct database
mutation.

## Solution Statement

Keep authentication in the existing Shell/Core capability and implement five cooperating layers:

1. Extend the Shell-owned Better Auth instance with the pinned API Key and Admin plugins and their
   generated Drizzle schema. Better Auth remains the only owner of raw key generation, hashing,
   verification, expiration, counters/rate limits, enabled state, and impersonation sessions.
2. Generalize Core principal resolution around an explicit stable provider subject
   `{ provider, subjectType, providerSubjectId }`. Enforce that one Better Auth API-key ID has at
   most one Core binding globally, while Better Auth users retain tenant-specific multi-binding
   support.
3. Add generated `core.identity.*` Actions for every Core principal/binding mutation and the
   sensitive impersonation evidence lifecycle. Shell orchestrates Better Auth mechanics with these
   Actions in fail-closed, compensating order and never places raw key material in an Action payload.
4. Add governed Core identity reads and tenant-level SpiceDB permissions for self-service access,
   identity administration, and support impersonation. Shell joins authorized Core binding results
   with Auth-owned non-secret key metadata without crossing schema ownership.
5. Construct each trusted principal context through one mode-specific path. Session, API-key,
   impersonation, and system contexts satisfy cross-field invariants before Action/Read runtimes;
   every operation revalidates the effective tenant/principal/binding and, for impersonation, the
   tenant-local original administrator and continuing support permission.

API-key issuance creates the Better Auth credential first, then commits its Core binding, and only
then returns the raw key once. Binding failure disables the credential and returns no key.
Disable/revoke operations close the Core binding first; a temporarily enabled provider key without
an active binding remains unusable. Re-enable performs the provider update first and activates the
Core binding last. Rotation creates and binds the replacement before revoking the old binding, and
reports any provider-cleanup lag without withholding the one-time replacement secret.

Support impersonation uses the current tenant, requires a non-empty reason, an active target human
user binding, an active original administrator binding in that same tenant, the restricted
`core.identity.record-support-impersonation` Action, and tenant `impersonate` permission. Shell
records a requested checkpoint, creates the Better Auth impersonation session, sets its selected
tenant and clears legal-entity selection, then records a started checkpoint containing only the
safe session reference. Failure to persist the started checkpoint revokes the new session. Stop
restores the original session and records a stopped checkpoint. Impersonated writes run with the
target's permissions and Policies, not the support administrator's permissions.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits work to `app/` and mandates Codesmith for every Action.
- `AGENTS.md` — defines Shell/Core authentication ownership, strict Effect boundaries, governed
  operations, database ownership, and generator rules.
- `README.md` — documents workspace topology, commands, and the existing Shell authentication BFF.
- `docs/architecture/ACTIONS.md` — requires Actions for Core mutations and defines the narrow Better
  Auth credential/session lifecycle exception.
- `docs/architecture/DATA_ACCESS.md` — requires immutable, revalidated operational scope and governed
  reads with durable evidence.
- `docs/architecture/DATABASE.md` — keeps `auth` and `core` schema histories and typed Drizzle access
  owner-local.
- `docs/architecture/ERRORS.md` — defines typed Effect errors, RFC 9457 responses, and `401`, `403`,
  `429`, `503`, and `500` semantics.
- `docs/architecture/MICROVERTICALS.md` — keeps authentication out of a MicroVertical and preserves
  audience-scoped gateway assertions.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — requires structured Core entrypoints and fail-closed
  context checks before private implementation resolution.
- `docs/architecture/ULTRAMODERN.md` — requires direct strict Effect API topology and generated
  business artifacts.
- `../docs/07_RUNTIME_CONSISTENCY_MODEL.md` — defines authentication and impersonation evidence
  semantics.
- `../docs/09_AUTHN_AUTHZ_MODEL.md` — defines Better Auth/API-key ownership, Core bindings, system
  jobs, impersonation, and effective-actor recording.
- `../docs/11_V0_SCOPE_AND_MODULES.md` — requires V0 Better Auth user/API-key bindings and basic
  service/integration principals.
- `../docs/adr/0014-authenticated-principal-session.md` — requires active Better Auth subjects to
  resolve through active tenant-local Core identity.
- `apps/shell-super-app/package.json` — owns the pinned Better Auth/API-key dependency and focused
  Auth validation commands.
- `apps/shell-super-app/shared/api.ts` — owns the strict Effect contracts for lifecycle and
  impersonation endpoints.
- `apps/shell-super-app/api/index.ts` — composes typed handlers, Core Action/Read runtimes, and
  Problem Details mappings.
- `apps/shell-super-app/api/auth/config.ts` — validates Better Auth and mechanical support-plugin
  configuration.
- `apps/shell-super-app/api/auth/service.ts` — owns Better Auth session resolution and must construct
  session/impersonation contexts without exposing provider records.
- `apps/shell-super-app/api/auth/db/schema.ts` — Shell-owned Better Auth Drizzle schema to regenerate
  for the API Key and Admin plugins.
- `apps/shell-super-app/api/auth/db/catalog.ts` — exact Auth table inventory.
- `apps/shell-super-app/api/auth/errors.ts` — existing typed Shell authentication failure vocabulary.
- `apps/shell-super-app/api/auth/gateway-issuer.ts` — issues the existing audience-scoped assertion
  after trusted context resolution.
- `apps/shell-super-app/api/auth/legal-entity-selection.ts` — existing legal-entity validation to
  reuse for optional API-key exchange context.
- `apps/shell-super-app/src/api/auth-client.ts` — typed client wrappers for the expanded Shell Auth
  contract; no route or UI will consume the new administration operations in this feature.
- `apps/shell-super-app/scripts/verify-auth-db-schema.mts` — verifies all typed Auth plugin tables and
  independent migration bookkeeping.
- `apps/shell-super-app/tests/unit/auth-schema.test.ts` — proves the exact generated plugin schema.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — proves endpoint methods, paths, schemas,
  safe response fields, and HTTP status unions.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — proves live session, API-key,
  gateway, lifecycle, compensation, and impersonation behavior.
- `packages/shared-contracts/src/gateway-context.ts` — shared assertion request/claims/client contract
  and fixed five-minute TTL.
- `packages/shared-contracts/tests/unit/gateway-context.test.ts` — assertion schema, client, and
  secret-stripping coverage.
- `packages/core-runtime/src/db/schema.ts` — principal kinds, subject types, binding cardinality, and
  durable authentication evidence constraints.
- `packages/core-runtime/src/auth/principal-resolver.ts` — current user-only resolver to generalize.
- `packages/core-runtime/src/auth/principal-resolver-errors.ts` — typed fail-closed resolution errors.
- `packages/core-runtime/src/actions/principal-context.ts` — trusted context schema and mode-specific
  cross-field invariants.
- `packages/core-runtime/src/operations/context.ts` — operation-time tenant, principal, binding,
  legal-entity, and impersonator revalidation.
- `packages/core-runtime/src/permissions/context-access.ts` — tenant/legal-entity authorization
  adapter to extend with identity-admin and impersonation checks.
- `packages/core-runtime/spicedb/bootstrap.yaml` — local schema and restricted identity Action proof.
- `packages/core-runtime/src/index.ts` — narrow public Core identity contracts and generated Action
  exports.
- `packages/core-runtime/tests/unit/principal-resolver.test.ts` — subject-type classification and
  fail-closed resolver coverage.
- `packages/core-runtime/tests/integration/principal-resolver.test.ts` — PostgreSQL binding
  cardinality, status, and tenant-isolation coverage.
- `packages/core-runtime/tests/unit/operation-context.test.ts` — mode invariants and impersonator
  revalidation behavior.
- `packages/core-runtime/tests/integration/context-access.test.ts` — live tenant permission checks.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — generated identity Action
  lifecycle, authorization, transaction, and evidence coverage.
- `scripts/verify-application-db-schema.mts` — composed Auth/Core schema verification.
- `scripts/scaffolding/action/scaffold.mts` — mandatory generator used unchanged for the initial
  Core Action files and exports.
- `package.json` — exact workspace validation commands.

### New Files

- `packages/core-runtime/src/modules/actions/create-non-human-principal.action.ts` — generated
  sensitive Action for tenant-local `service`, `integration`, or `system` principals.
- `packages/core-runtime/src/modules/actions/change-principal-status.action.ts` — generated
  sensitive Action for guarded non-human principal lifecycle transitions.
- `packages/core-runtime/src/modules/actions/bind-self-api-key.action.ts` — generated Action that can
  bind a verified Better Auth key ID only to the calling human principal.
- `packages/core-runtime/src/modules/actions/set-self-api-key-binding-status.action.ts` — generated
  Action for a human principal's own API-key binding lifecycle.
- `packages/core-runtime/src/modules/actions/bind-managed-api-key.action.ts` — generated sensitive
  Action for binding a key ID to a tenant-local service/integration principal.
- `packages/core-runtime/src/modules/actions/set-managed-api-key-binding-status.action.ts` —
  generated sensitive Action for managed binding disable, re-enable, and terminal revocation.
- `packages/core-runtime/src/modules/actions/record-support-impersonation.action.ts` — generated
  sensitive Action for requested, started, and stopped impersonation checkpoints.
- `packages/core-runtime/src/auth/principal-management.ts` — transaction-scoped Core services for
  principal/binding transitions and sanitized impersonation evidence.
- `packages/core-runtime/src/auth/principal-management-errors.ts` — typed lifecycle conflicts,
  invalid targets/transitions, and persistence failures.
- `packages/core-runtime/src/auth/principal-administration-reads.ts` — governed self and managed
  principal/binding metadata reads.
- `packages/core-runtime/src/auth/system-principal-context.ts` — Core-owned trusted system-operation
  registration and context resolver.
- `packages/core-runtime/tests/unit/principal-management.test.ts` — lifecycle transition and secret
  exclusion tests.
- `packages/core-runtime/tests/unit/system-principal-context.test.ts` — branded registration,
  validation, and fail-closed construction tests.
- `packages/core-runtime/tests/integration/principal-management.test.ts` — live Action/read,
  cardinality, evidence, and tenant-isolation proof.
- `apps/shell-super-app/api/auth/api-key-service.ts` — Auth-owner Effect adapter for Better Auth key
  issue, verify, safe metadata, enabled state, and compensation.
- `apps/shell-super-app/api/auth/identity-lifecycle.ts` — Shell orchestration across Auth mechanics
  and generated Core Actions/reads.
- `apps/shell-super-app/api/auth/impersonation-service.ts` — Shell orchestration for start, resolution,
  revalidation, stop, cookie forwarding, and compensation.
- `packages/core-runtime/drizzle/*.sql` — Drizzle-generated Core migration for API-key binding
  cardinality/lifecycle constraints.
- `apps/shell-super-app/drizzle-auth/*.sql` — Drizzle-generated Auth migration for API Key/Admin
  plugin tables and fields.

## Implementation Plan

### Phase 1: Foundation

Generate every Core identity Action before editing its payload, handler, service factory, or export.
Install the API-key plugin at the exact Better Auth `1.6.23` cohort used by `develop`, enable the
Better Auth Admin plugin, regenerate the complete Auth Drizzle model, and generate independent Auth
and Core migrations. Generalize Core subject resolution, enforce global API-key binding
cardinality, strengthen trusted-context cross-field invariants, add tenant permission checks, and
provide a Core-only system context constructor.

### Phase 2: Core Implementation

Implement generated Core Actions for non-human principal creation/status, self and managed API-key
bindings, and impersonation evidence. Add governed reads for self-service and tenant identity
administration. Mark every sensitive `core.identity.*` Action as restricted in SpiceDB and require
explicit executor relationships; no identity administration Action may inherit the existing
unconfigured-Action compatibility allow in a deployed environment.

Implement Shell-owned credential mechanics and compensating orchestration. Human keys bind only to
the current human principal. Managed keys are Better Auth user-owned by the issuing administrator
but bind only to active service/integration principals in that administrator's tenant. Any tenant
administrator with the required SpiceDB permission can manage them through OntOS, independently of
the issuing human.

### Phase 3: Integration

Add a dedicated API-key exchange endpoint using `X-API-Key` and payload
`{ audience, legalEntityId? }`. Resolve one tenant/principal from the stable key ID, validate an
optional legal entity, and issue the existing audience-scoped assertion with `authMethod = api_key`,
the Core binding ID, and a safe Better Auth key reference.

Integrate Better Auth impersonation sessions with tenant-local Core resolution. Require the support
administrator and target to have active user bindings in the same tenant, continuously recheck
support permission, propagate effective/original actor evidence through gateway assertions and
Actions/reads, and allow writes only under the target principal's authorization and Policies.
Exercise all modes through unit, PostgreSQL/SpiceDB/Auth integration, schema verification, and build
validation without adding browser UI.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate every Core identity Action

- [x] From `app/`, run these mandatory Codesmith commands before creating or editing the Action
      files:
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action create-non-human-principal --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action change-principal-status --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action bind-self-api-key --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action set-self-api-key-binding-status --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action bind-managed-api-key --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action set-managed-api-key-binding-status --legal-entity-scope optional`
  - `mise exec -- pnpm scaffold:action -- --scope core --module core.identity --action record-support-impersonation --legal-entity-scope optional`
- [x] Verify Codesmith created only Core-owned files under
      `packages/core-runtime/src/modules/actions/`, patched only the reserved Core export slot, used
      explicit system entrypoints, and did not create an Auth vertical or generic endpoint.

### 2. Add Better Auth API-key and impersonation persistence

- [x] Add `@better-auth/api-key` at the exact compatible `1.6.23` cohort to
      `apps/shell-super-app/package.json`; use the Admin plugin from the existing `better-auth` package
      and keep API-key mock sessions disabled so one request performs one explicit verification.
- [x] Configure one user-referenced API-key configuration only. Do not enable Better Auth
      organizations or store OntOS permissions in Better Auth key permissions/metadata.
- [x] Configure the Admin plugin as a mechanical prerequisite for explicitly configured support
      Better Auth user IDs, but retain SpiceDB as the authoritative tenant/target permission check and
      keep every raw Better Auth plugin route private.
- [x] Use the pinned Better Auth schema generator as the source for the API Key and Admin plugin
      fields, adapt the complete output to `pgSchema('auth')`, add the `apikey` table to the exact Auth
      inventory/relations, and add the Admin user fields plus `session.impersonatedBy`. Retain existing
      tenant/legal-entity session fields and add only server-owned impersonation context fields proven
      necessary for reason/action correlation.
- [x] Generate the Auth migration through `mise exec -- pnpm --filter @app/shell-super-app
db:generate`; update typed schema/catalog tests and verification so the raw key hash remains only
      in Auth and no Auth table appears in `core` or `public`.

### 3. Generalize and constrain Core identity storage

- [x] Add exported frozen principal-kind, binding-subject, and binding-status vocabularies in
      `packages/core-runtime/src/db/schema.ts` and reuse them in schemas/services instead of repeating
      unchecked strings.
- [x] Add a partial global unique index for Better Auth `subject_type = api_key` over provider,
      subject type, and provider subject ID so one stable key ID can bind to exactly one tenant and
      principal; retain tenant-scoped multi-binding behavior for `subject_type = user`.
- [x] Add binding lifecycle checks so active/disabled bindings have no `revoked_at`, revoked
      bindings have a timestamp, and terminal revocation cannot be silently reactivated.
- [x] Generate the Core migration through `mise exec -- pnpm --filter @app/core-runtime
db:generate`; extend schema, catalog, migration, and tenant-isolation tests for duplicate
      cross-tenant API-key IDs, user multi-tenancy, same-tenant foreign keys, and lifecycle constraints.

### 4. Resolve explicit provider subjects and trusted authentication contexts

- [x] Replace user-specific internal resolver loading with an explicit decoded provider-subject
      input and add exact APIs for user default/selected-tenant resolution, API-key resolution without a
      tenant selector, and target/original user resolution for impersonation. Preserve the current
      session-facing methods as narrow wrappers where they aid compatibility.
- [x] Make API-key resolution fail closed for zero, duplicate, inactive, revoked, or cross-tenant
      bindings and for inactive principals/tenants. Return only the stable binding ID, effective
      principal, tenant, display fields, and principal kind; never accept or return a raw key.
- [x] Extend resolver unit/PostgreSQL tests for human, service, and integration results, one-key-one-
      binding enforcement, user multi-tenant selection, all inactive states, and redacted database
      unavailability.
- [x] Strengthen `TrustedPrincipalContextSchema` with cross-field rules: session requires an active
      binding and safe session reference; API key requires an active binding and safe key reference;
      support impersonation requires target binding/reference plus a distinct tenant-local original
      principal; system requires a safe job/run reference and forbids binding, impersonator, and legal
      entity by default.
- [x] Replace loose context literals in production composition with mode-specific constructors and
      update focused tests to prove malformed combinations never reach Action/Read runtimes or gateway
      signing.

### 5. Add tenant identity permissions and impersonation revalidation

- [x] Extend the SpiceDB tenant definition with explicit `identity_admin` and `support` relations
      and `manage_identity` and `impersonate` permissions while preserving existing membership/access
      semantics.
- [x] Extend `ContextAccess` with exact tenant permission checks and extend governed Read permission
      targeting with a tenant target carrying only the approved permission. Fail conditional,
      malformed, missing, or unavailable decisions closed and retryably.
- [x] Update `OperationalScopeRepository` and resolver behavior so support impersonation revalidates
      the effective target tenant/principal/binding, the original administrator as an active principal
      in the same tenant, and the original administrator's continuing tenant `impersonate` permission.
      Definite loss of permission is `403`; authorization/provider uncertainty is retryable `503`.
- [x] Add unit and live SpiceDB/PostgreSQL tests for identity administrator allow/deny, support
      allow/deny, cross-tenant original administrators, disabled original/effective principals,
      unavailable checks, and non-impersonated behavior remaining unchanged.

### 6. Implement non-human principal and binding Actions

- [x] Adapt `create-non-human-principal` to accept only `service`, `integration`, or `system`, create
      the principal in `context.scope.tenantId`, use a sensitive audit profile, require idempotency, and
      return no credential data. Keep `agent` representable in the schema but unavailable through this
      V0 production Action.
- [x] Adapt `change-principal-status` with expected-state concurrency, active/disabled/archived
      transition rules, terminal archive semantics, same-tenant target validation, and a mandatory safe
      reason for disable/archive.
- [x] Implement self binding/status Actions so their target is always
      `context.scope.principalId`, the principal kind is `human`, the provider subject is a stable
      verified Better Auth key ID, and the payload cannot name another principal or carry raw key
      material.
- [x] Implement managed binding/status Actions so only active `service` or `integration` targets in
      the caller's tenant are accepted; `system`, `agent`, `human`, foreign, missing, inactive, and
      archived targets fail with declared typed domain errors.
- [x] Implement active/disabled/revoked binding transitions with expected-state concurrency and a
      mandatory reason for revocation. Revocation sets `revoked_at` once and is terminal.
- [x] Build every handler over transaction-scoped Core identity services, record bounded metadata-
      only reads for checked targets/current state, expose no executor, and add unit/PostgreSQL Action
      tests for success, conflicts, idempotency, denial, rollback, evidence, and tenant isolation.
- [x] Add SpiceDB restriction markers for all sensitive `core.identity.*` Action keys and test that
      an identity Action without an explicit executor relation is denied. Document deployment
      provisioning of executor relationships; do not rely on the unconfigured-Action compatibility
      allow for these Actions.

### 7. Add governed identity administration reads

- [x] Define Core system reads for a human principal's own API-key bindings and for identity
      administrators to list tenant-local service/integration principals plus their non-secret binding
      metadata. Use legal-entity scope `optional`, tenant permission targets (`access` for self and
      `manage_identity` for managed reads), metadata-only evidence, bounded pagination, and stable sort
      order.
- [x] Return no raw key, hash, Better Auth owner/reference ID, provider metadata blob, session ID,
      database diagnostics, or foreign-tenant identifier. The provider subject key ID remains a private
      Shell/Core join key and must be stripped from the public response.
- [x] Add ReadRuntime unit/PostgreSQL tests for self-only filtering, managed authorization,
      pagination, empty results, disabled/revoked metadata, denied evidence, unavailable evidence, and
      tenant leakage.

### 8. Implement Shell API-key lifecycle orchestration

- [x] Add an Auth-owner Effect service around Better Auth's supported create/verify/update APIs and
      typed Auth Drizzle metadata access. Never expose the Auth executor, stored hash, raw provider
      record, or issuing Better Auth user ID outside the private service.
- [x] Extend the strict Shell API contract/runtime with backend-only operations to create/list/change
      non-human principals; issue/list/disable/re-enable/revoke/rotate self and managed API keys; and
      return raw key material only in the successful issue/rotate response that created it.
- [x] For service/integration issuance, set the Better Auth key owner to the authenticated issuing
      human while binding the stable key ID to the managed principal. Permit later management by any
      current tenant identity administrator through the governed OntOS APIs, not the provider's
      user-scoped public endpoints.
- [x] Orchestrate issue as provider create, generated Core bind Action, then one-time response. If
      binding fails, disable the provider key and reveal no raw secret. Treat an unreachable cleanup as
      sanitized retryable cleanup debt while the absent binding keeps the key unusable.
- [x] Orchestrate disable/revoke by closing the Core binding before disabling the provider key;
      orchestrate re-enable by enabling the provider key before activating the Core binding. Make each
      operation retry-safe and report provider-cleanup lag without misrepresenting Core usability.
- [x] Orchestrate rotation by creating/binding the replacement before revoking the old binding. Once
      the old Core binding is closed, return the new one-time secret even if provider cleanup needs a
      retry; never return a `503` that causes the caller to unknowingly lose the only copy of a newly
      active secret.
- [x] Map malformed payloads to `400`, absent/invalid sessions to `401`, tenant/self/administrator
      denial to `403`, lifecycle conflicts to `409` or semantic ineligibility to `422`, provider rate
      limits to `429` with a safe retry hint, provider/Core unavailability to retryable `503`, and caught
      defects to sanitized `500` Problem Details.
- [x] Extend client wrappers and contract/runtime tests for every operation, exact error statuses,
      one-time secret behavior, all compensation paths, cross-admin managed-key operation, redaction,
      and absence of raw Better Auth routes. Add no page, route component, locale copy, or Playwright UI
      flow.

### 9. Add central API-key assertion exchange

- [x] Add `POST /auth/api-key/gateway-context` to the shared/Shell Effect contract with
      `X-API-Key` as the only raw credential input and payload `{ audience, legalEntityId? }`; do not
      accept tenant, principal, binding, auth method, impersonator, or context-reference input.
- [x] Verify the key exactly once through Better Auth so expiration, enabled state, remaining count,
      and rate limiting are provider-owned; resolve the returned stable key ID through Core and derive
      tenant/principal/binding exclusively from that result.
- [x] Validate an optional legal entity through the existing Core legal-entity context and SpiceDB
      access path. An omitted legal entity remains valid for exchange, but any target operation that
      declares it required must reject the assertion before private code resolves.
- [x] Issue the existing 300-second assertion with `authMethod = api_key`, the active Core binding
      ID, `authContextRef = better-auth-api-key:{stable-id}`, and no raw credential/provider owner data.
      Reuse audience allowlisting and EdDSA signing; do not introduce a second token format.
- [x] Map missing/malformed/expired/disabled keys and inactive/missing bindings to `401` with an
      API-key challenge, active credentials resolving to forbidden tenant/principal/legal-entity state
      to `403`, rate limit to `429`, invalid audience/payload to `400`, dependency uncertainty to
      retryable `503`, and caught defects to sanitized `500`.
- [x] Extend shared-contract, Shell contract, issuer, and integration tests to prove the raw key
      stops at Shell, one key cannot select another tenant/principal, legal-entity checks fail closed,
      the assertion verifies only for its audience, and receiving Action/Read runtimes persist API-key
      identity evidence.

### 10. Construct trusted system-operation contexts

- [x] Add a constructor-produced, immutable system workload registration carrying a stable job key;
      reject copied/plain objects and do not accept registrations from HTTP payloads, headers, cookies,
      or gateway claims.
- [x] Implement an Effect resolver that accepts the trusted registration, tenant ID, configured
      tenant-local principal ID, and non-secret run reference; reloads tenant/principal state; permits
      only active `system` or explicitly approved `service` principals in that tenant; and returns a
      frozen context with `authMethod = system`, no binding/impersonator/legal entity, and
      `authContextRef = job:{job-key}:run:{run-ref}`.
- [x] Require system principal provisioning through the generated non-human-principal Action or an
      existing trusted tenant bootstrap, never a fake Better Auth user/binding. Keep the principal ID in
      trusted job configuration/registration rather than deriving it from display name.
- [x] Add unit/PostgreSQL integration tests that invoke governed Core Action and Read paths with a
      resolved system context and prove inactive/foreign/wrong-kind principals, malformed refs, forged
      registrations, auth bindings, impersonation, and legal-entity context fail closed.

### 11. Implement complete support impersonation

- [x] Add typed backend-only `startSupportImpersonation` and `stopSupportImpersonation` Shell
      endpoints. Start accepts only a target OntOS principal UUID and a trimmed 1-500 character reason;
      tenant, provider user ID, permissions, auth method, and binding IDs come from trusted state.
- [x] Reject anonymous callers, already impersonated sessions, self/nested impersonation, foreign-
      tenant targets, non-human targets, targets without exactly one active Better Auth user binding,
      inactive principals/tenants, and support users without both the mechanical Better Auth capability
      and tenant `impersonate` permission. Preserve Better Auth's safe default that an administrator
      cannot impersonate another administrator.
- [x] Invoke `record-support-impersonation` as the original administrator for a `requested`
      checkpoint before creating the provider session. Store the original/effective principal IDs,
      safe reason, tenant, timestamp, and Action identity in sensitive audit evidence without storing a
      token, cookie, provider user ID, or session token.
- [x] Create the Better Auth target session, force its active tenant to the administrator's current
      tenant, clear legal-entity selection, retain the server-owned reason/action correlation, then
      invoke the same Action for a `started` checkpoint with only a safe session reference. If started
      evidence cannot commit, revoke/stop the new session and return a typed retryable failure.
- [x] On every impersonated session read, resolve the target user binding as effective
      `principalId`/`authBindingId`, resolve the original Better Auth user to an active principal in the
      same tenant as `impersonatedByPrincipalId`, set `authMethod = support_impersonation`, use the safe
      session ID as `authContextRef`, and continuously recheck tenant support permission.
- [x] Keep gateway assertion issuance available during impersonation. Receiving operations recheck
      target binding/principal/tenant and original principal/support permission; permission and Policy
      execution then use the effective target principal so support writes have exactly the target's
      powers and are attributable to both actors.
- [x] Stop through Better Auth, restore/forward all required cookies, and invoke the lifecycle Action
      with the reconstructed original administrator context for a `stopped` checkpoint. Make repeated
      stop safe and ensure losing support permission prevents new work while still allowing secure
      session termination.
- [x] Extend current-session safe output just enough to identify an active impersonation and permit
      API clients to stop it; do not expose the original provider user ID, provider role, session token,
      reason to unrelated clients, or an administration UI.
- [x] Add unit and live Auth/Core/SpiceDB integration tests for start/current session/gateway/write/
      stop, original/effective evidence columns, mandatory reason, same-tenant enforcement, target
      permissions, support permission revocation, admin-to-admin/nested denial, session expiry,
      started-evidence compensation, cookie propagation, and complete secret redaction.

### 12. Document the completed identity boundary

- [x] Update `docs/architecture/ACTIONS.md`, `DATA_ACCESS.md`, `ERRORS.md`, `MICROVERTICALS.md`, and
      `README.md` with the implemented subject resolver, credential lifecycle exception, one-key-one-
      tenant invariant, Shell-only raw-key boundary, assertion exchange, tenant-local support
      impersonation, system context construction, compensation semantics, typed error mappings, and
      exact operational provisioning requirements.
- [x] Document that `human` remains the V0 principal kind for internal/external/guest users while
      SpiceDB roles and future Party relationships express their access; do not add autonomous agent
      behavior or invent new principal-kind values in this feature.
- [x] Document Auth/API-key and support configuration without adding secrets or real identifiers to
      `.env.example`, tests, logs, or tracked files.

### 13. Run all validation commands

- [ ] From `app/`, execute every command under `Validation Commands` in order and resolve all
      failures without weakening typed errors, Action/Read lifecycles, tenant isolation, credential
      redaction, compensation, audience scoping, or the Shell/Core ownership boundary.

## Testing Strategy

### Unit Tests

Test provider-subject decoding/classification, principal and binding lifecycle transitions, partial
uniqueness, trusted-context cross-field rules, system registration branding, system context
resolution, tenant permission request mapping, generated Action descriptors/handlers/errors,
governed identity read filtering, Better Auth key result sanitization, lifecycle orchestration and
compensation, impersonation state construction, strict API schemas, Problem Details status unions,
gateway claims, and generated/client-facing secret stripping.

### Integration Tests

Use the existing PostgreSQL, Auth schema, and SpiceDB integration setup to prove complete flows:

- interactive session contexts now carry a safe session reference without behavior regression;
- human and managed key issuance creates Auth credentials plus exactly one Core binding and returns
  the raw key once;
- any authorized tenant administrator can manage a managed key regardless of provider owner;
- key verification/exchange yields an audience-scoped assertion and a receiving governed read or
  Action records `api_key` evidence;
- disabled, revoked, expired, rate-limited, cross-tenant, duplicated, and dependency-unavailable
  paths fail closed with declared errors;
- system contexts can invoke governed operations only for trusted registrations and valid
  tenant-local system/service principals; and
- support start, assertion issuance, target-authorized write, continuing permission recheck, and
  stop preserve effective/original actor evidence and compensation guarantees.

Browser/E2E tests are not required because the accepted scope explicitly excludes administration
UI. Existing login E2E behavior must remain green through the repository build and focused Shell
tests.

### Edge Cases

- One Better Auth user has active human bindings in several tenants; sessions retain explicit
  tenant selection while each API key binds to only one of them.
- One Better Auth key ID is submitted for a second tenant or principal.
- A key is valid in Better Auth but missing, disabled, or revoked in Core.
- A Core binding is active while the provider key is disabled, expired, exhausted, or rate-limited.
- Provider creation succeeds and Core binding fails; no raw key is returned.
- Core disable/revoke succeeds and provider cleanup is unavailable; the key remains unusable in
  OntOS and cleanup can be retried.
- Re-enable succeeds in the provider but Core activation conflicts; the still-inactive Core binding
  prevents use.
- A rotation response is interrupted after the replacement binding commits; metadata remains
  listable and the unreachable replacement can be revoked without exposing its hash.
- A human tries to use the self endpoint for another principal.
- A managed endpoint targets a human, system, agent, inactive, archived, or foreign principal.
- A revoked binding or archived principal is reactivated.
- API-key exchange omits legal entity and the target operation requires one.
- API-key exchange supplies a legal entity outside the bound tenant or principal's permission.
- The assertion audience is missing, unknown, or different at verification.
- A raw key, key hash, session token, cookie, provider owner ID, or signature diagnostic reaches a
  response, log, Action payload/evidence, gateway claim, or Core table.
- A system caller forges a registration, supplies a human principal, crosses tenants, includes an
  auth binding/legal entity, or omits the job/run reference.
- A support administrator has no binding in the target tenant, loses support permission after
  session creation, or becomes disabled during an issued assertion's lifetime.
- The target user/binding/tenant becomes disabled or revoked during impersonation.
- Support attempts self, nested, admin-to-admin, cross-tenant, or reasonless impersonation.
- Better Auth creates an impersonation session but started evidence fails; the session is revoked.
- Stop is repeated, the original session is expired, or evidence persistence is temporarily
  unavailable.

## Acceptance Criteria

- [x] Existing interactive Better Auth login/session/tenant/legal-entity behavior remains working
      and now supplies `authMethod = session`, active target binding ID, and a safe non-secret session
      reference to governed operation evidence.
- [x] The Shell Auth schema and runtime use Better Auth `1.6.23` API Key/Admin plugins, and Better
      Auth alone stores raw-key hashes, expiration, rate-limit/counter state, enabled state, roles, and
      impersonation sessions.
- [x] No raw API key, API-key hash, session token, cookie value, provider user ID, or provider
      diagnostic is stored in Core or exposed through logs, Problem Details, assertions, lifecycle
      lists, or Action/read evidence.
- [x] A Better Auth API-key ID can have at most one Core binding globally; multi-tenant integrations
      require separate keys, while Better Auth user bindings continue to support explicit tenant
      selection.
- [x] Human keys resolve to their human principal, and managed keys resolve to the selected active
      service/integration principal regardless of which authorized human issued the provider key.
- [x] Backend lifecycle APIs support non-human principal create/status plus API-key issue, list,
      disable, re-enable, revoke, and rotate for self and managed principals with typed errors and no UI.
- [x] Every Core principal/binding mutation and support impersonation checkpoint runs through its
      generated restricted `core.identity.*` Action with idempotency, sensitive evidence where
      applicable, permission checks, typed failures, and transaction-scoped services.
- [x] Credential/session mechanics remain the documented Shell-owned exception and are orchestrated
      so partial provider/Core failure is fail-closed; raw one-time secrets are never lost behind a
      misleading retryable error after becoming active.
- [x] `POST /auth/api-key/gateway-context` verifies `X-API-Key` only at Shell, derives one
      tenant/principal/binding from Core, validates optional legal entity, and returns the existing
      five-minute assertion for exactly one allowed MicroVertical audience.
- [x] MicroVerticals receive only the assertion and business payload; they never receive or verify a
      raw external API key.
- [x] Receiving governed Actions/reads revalidate API-key scope and persist `principal_id`,
      `auth_binding_id`, `auth_method = api_key`, and a safe key reference.
- [x] Trusted system-operation construction is unavailable over HTTP and succeeds only for a
      constructor-produced workload registration plus an active tenant-local system/service principal;
      it records `auth_method = system`, no binding, and a bounded job/run reference.
- [x] Support impersonation requires a reason, active same-tenant original and target user
      identities, Better Auth mechanical capability, and SpiceDB support permission; it supports writes
      only with the target's authorization/Policies.
- [x] Impersonated Action/read evidence records the target as `principal_id`, the target user's
      binding as `auth_binding_id`, `auth_method = support_impersonation`, the original administrator as
      `impersonated_by_principal_id`, and a safe session reference.
- [x] Support permission and both principals are revalidated for ongoing impersonated work; losing
      permission fails closed but does not prevent secure stop/cleanup.
- [x] Started-evidence failure revokes the newly created impersonation session, and repeated stop is
      safe.
- [x] Agent principals remain model-only; Better Auth organizations, a global support principal,
      autonomous agents, Auth MicroVertical, generic Action endpoint, and administration UI are absent.
- [x] Tenant leakage tests cover user multi-binding, global API-key uniqueness, lifecycle APIs,
      legal-entity exchange, managed principals, system contexts, and impersonation.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — validate all generated identity
  Action descriptors, errors, handlers, and runtime invariants.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — run Core identity, operation-context,
  Action/read, PostgreSQL, SpiceDB, and tenant-isolation tests.
- `mise exec -- pnpm --filter @app/shared-contracts test:unit` — validate gateway request, claims,
  assertion client, and secret-stripping contracts.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Auth schema, strict API
  contracts, typed mappings, and existing Shell behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — run live Better Auth/Core
  session, key lifecycle, exchange, compensation, and impersonation flows.
- `mise exec -- pnpm db:verify` — compare the migrated Core/Auth catalogs and typed table access with
  the exact owner inventories.
- `mise exec -- pnpm check` — run the final repository quality gate.
- `mise exec -- pnpm build` — build the Shell strict Effect BFF and shared gateway contract with the
  completed identity modes.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

Implementation and both final review axes are complete. The spec remains `in_progress` only because
the local live database/SpiceDB validation environment is not in the required migrated,
least-privilege state.

- Generated all seven Core identity Actions with the mandatory Codesmith commands before adapting
  them, and generated both Core and Auth migrations with the repository generators.
- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — passed, 58/58 tests.
- `mise exec -- pnpm --filter @app/shared-contracts test:unit` — passed, 5/5 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 130/130 tests.
- `mise exec -- pnpm check` — passed, including formatting, lint, Action tests, typechecking, skills,
  API/database/module boundaries, contracts, and performance readiness.
- `mise exec -- pnpm build` — passed, including the stricter TS-Go BFF compile, deployment output,
  Module Federation types, and performance readiness.
- `git diff --check` — passed.
- Fresh spec review after the fix/review loop — no P0-P2 findings.
- Fresh `AGENTS.md` and referenced-standards review after the fix/review loop — no P0-P2 findings.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — attempted; database-backed cases are
  blocked by the local environment (`DATABASE_ADMIN_URL` is unavailable and the configured local
  SpiceDB pre-shared key is rejected). Non-environmental tests completed cleanly before the blocked
  run was stopped.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — attempted; 2/6 passed and the
  remaining cases are blocked by the unapplied local Auth migration or missing
  `DATABASE_ADMIN_URL`.
- `mise exec -- pnpm db:verify` — attempted; blocked because the configured runtime database role is
  currently a superuser/has `BYPASSRLS`, which intentionally fails the least-privilege verifier.

To finish validation, apply the generated Core/Auth migrations to the disposable integration
database, provide its administrator connection to the existing test harness, configure the matching
local SpiceDB key, and rerun the three blocked commands in their documented order. No application
code finding remains open.

## Notes

- Decisions fixed in planning: implement every documented mode, route raw API keys only through
  Shell/Core, include complete backend lifecycle but no UI, support human and dedicated
  service/integration keys, omit Better Auth organizations, map one key to exactly one tenant and
  principal, let any authorized tenant administrator manage a managed key, preserve tenant-local
  support administrators, and allow impersonated writes.
- Better Auth API-key ownership is provider context, not OntOS actor identity. For managed keys the
  issuing human is Better Auth's owner, while the bound service/integration principal is the actor
  recorded and authorized for API calls.
- Better Auth's API-key plugin supports create, verify, update, expiration, enabled state, counters,
  rate limiting, and user ownership. Its user-scoped delete/list endpoints are not exposed; the
  Shell Auth owner may use typed owner-local persistence for authorized cross-admin metadata and
  disable/cleanup, consistent with the provider's documented owner-independent administration
  guidance.
- Better Auth's Admin plugin stores the original provider user ID on the impersonation session.
  Core resolves that ID to a tenant-local original administrator on every Shell session read but
  persists only the OntOS principal ID and safe session reference in operation evidence.
- The target user's Core binding is `auth_binding_id` during impersonation because it must match the
  effective principal. The original administrator is represented by
  `impersonated_by_principal_id`; no second binding column or fake impersonation binding is added.
- Authentication lifecycle operations are Shell-owned mechanics under the explicit exception in
  `docs/architecture/ACTIONS.md`. Creating/changing a Core principal, Core binding, or Core audit
  checkpoint is not exempt and always uses a generated Action.
- `human` remains the physical V0 principal kind for internal users, external operator users, and
  guests. Their distinctions belong in authorization roles and future Party/domain relationships,
  not additional authentication modes in this feature.
- System operations may use a `system` principal or an explicitly configured `service` principal as
  allowed by `../docs/09_AUTHN_AUTHZ_MODEL.md`. They never create a Better Auth binding and are not
  callable through the public gateway.
- Existing Action permission behavior allows an unconfigured Action for compatibility. Every new
  sensitive identity Action must have a restriction marker and explicit executor provisioning so
  that compatibility behavior is never its production authorization posture.
- API-key issuance cannot replay a raw one-time secret after a lost client response. A retry may
  issue another key; authorized metadata listing and revocation make the unreachable key
  recoverable without exposing its hash. Core binding Actions remain idempotent by stable provider
  key ID.
- No unresolved product or architecture decision blocks implementation.
