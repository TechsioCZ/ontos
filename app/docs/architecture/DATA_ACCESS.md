# Governed Data Access and Operation Scope

This contract governs every public or business read and write. It complements the entrypoint
`tenant`/`system` scope with an independent legal-entity scope and makes CoreSDK the only owner of
trusted operation context, transaction creation, and durable access evidence.

## OperationalScope

`OperationalScope` is immutable, server-only Core runtime state. Core constructs it from an
authenticated Shell session or a verified audience-scoped gateway assertion. Browser payloads and
identity headers never establish tenant, principal, auth-binding, or legal-entity identity. The
scope contains only revalidated tenant, principal, optional auth binding, optional legal entity,
authentication metadata, correlation ID, and optional trace ID; it is never persisted as generic
JSON or exposed through browser-safe contracts.

Every descriptor declares both dimensions explicitly:

- entrypoint scope `tenant` or `system` controls tenant module-state gating;
- legal-entity scope `required`, `optional`, or `forbidden` controls whether a selected legal entity
  must be present, is validated when present, or must be absent.

Tenant scope does not imply legal-entity scope. Omitted, malformed, stale, inactive, cross-tenant,
denied, conditional, or indeterminate context fails closed before module state, permission, Policy,
owner service factory, or private handler resolution. Definite authentication/context failures are
typed separately from retryable database or authorization unavailability.

Core rechecks the active tenant and principal, verifies an optional auth binding is active and
belongs to that tenant/principal, verifies an optional legal entity is active and belongs to the
tenant, and checks the principal's legal-entity access. System/background operations must use an
explicit system entrypoint and `forbidden` legal-entity scope unless their approved descriptor and
runtime contract state otherwise; they are not reachable through business handler capabilities.

Mode-specific trusted context is closed and revalidated: sessions require an active user binding
and `better-auth-session:` reference; API keys require the single active key binding and
`better-auth-api-key:` reference; support impersonation uses the target as effective principal and
binding while retaining the active original administrator plus continuing tenant `impersonate`
permission; system work requires a branded registration and `job:{job}:run:{run}` reference with no
binding, impersonator, or legal entity. Raw credentials and provider ownership never enter the
scope, read evidence, gateway claims, or Core tables.

Identity list endpoints are governed Core reads. Shell may join their authorized binding IDs to
Auth-owned non-secret metadata, including terminal revoked bindings for administration, but strips
the stable provider key ID before encoding a response. The one-key-one-binding database invariant
prevents an API key from selecting another tenant or principal.

Identity operations are tenant-level and use `legalEntityScope = optional`; resolving their trusted
session context does not require an unrelated legal-entity selection. When a legal entity is present
it remains subject to normal Core revalidation. API-key list responses derive provider cleanup debt
from Core binding status versus Auth enabled state rather than hiding a partially completed
transition.

## Scoped Owner Services

Core owns the top-level transaction. It installs transaction-local `ontos.tenant_id` and, when
present, `ontos.legal_entity_id`, verifies both settings in the same transaction, and only then
constructs the owner's private service factory. Action and read handlers receive immutable scope,
operation identity, collector/evidence methods, and typed owner-local services. They never receive
or import Drizzle, `pg`, a pool, a database executor, transaction creation, commit/rollback, Core
evidence repositories, or another owner's schema/repository. A service object built over a global
pool is invalid.

## Governed Read Lifecycle

Core runs reads in this exact order:

1. Decode business input.
2. Authenticate and revalidate `OperationalScope`.
3. Acquire one module-state snapshot and gate the structured read entrypoint.
4. Check legal-entity, module, and resource permission as declared.
5. Evaluate immutable Policy references sequentially and fail fast.
6. Open a read transaction and install and verify database scope.
7. Construct owner-local services and resolve and run the private handler.
8. Decode the declared result and build bounded metadata/hash evidence.
9. Commit durable allowed evidence before releasing the result.

Definite authorization or Policy denial runs no handler and writes sanitized denied evidence in a
separate Core-owned transaction. Indeterminate context, permission, Policy, or evidence persistence
fails closed and retryably. Evidence contains no raw query, result rows, provider diagnostics,
authorization internals, or foreign identifiers. Metadata-only is the default; hash-only or an
already-supported redacted mode requires an explicit descriptor policy.

The private permission-target resolver derives module/resource targets only from decoded business
input and immutable scope; transport metadata never chooses an authorization target. Search
providers also declare a private result-target resolver. Core bulk-checks every returned resource
reference and releases no result if any reference is denied or indeterminate. Metadata-only reads
reject hashes, while hash-only reads accept only bounded SHA-256 values and paired fingerprint
metadata.

Every Shell-to-MicroVertical provider attempt acquires a fresh assertion for that provider's app
audience. The provider transport receives only the resulting Authorization value and business
payload; receiving BFFs verify the Bearer assertion before invoking `ReadRuntime`.

## PostgreSQL Isolation

`DATABASE_ADMIN_URL` is used only for role/schema/migration work. `DATABASE_URL` is the application
pool and must authenticate as a non-superuser role without `BYPASSRLS`. The URLs must not be
identical. Local/test bootstrap creates or updates `ontos_runtime`, grants only schema/table/sequence
usage needed by the application, and verifies its capabilities.

Owner tenant tables use enabled and forced RLS. Tenant-only policies compare `tenant_id` with
`current_setting('ontos.tenant_id', true)` for `USING` and `WITH CHECK`. Legal-entity-owned policies
also compare `legal_entity_id` with `current_setting('ontos.legal_entity_id', true)`. Missing or
malformed settings match no rows and permit no writes. Settings use parameterized
`set_config(..., true)`, are verified before owner services exist, and disappear at transaction end.

Core global catalogs, schedulers, delivery state, and checkpoints deliberately remain Core-private
instead of becoming a business-handler RLS surface because controlled global scans are required.
All Core rows carrying a tenant plus a referenced legal entity, principal, auth binding, Action
invocation, audit/data-access/domain event, evidence, media, outbox, or checkpoint use composite
same-tenant uniqueness and foreign keys. This database invariant remains effective if application
validation is bypassed.

## Public Errors

Transport adapters map declared typed failures only: missing or unusable authentication to `401`,
definite permission denial to `403`, semantic Policy denial to its declared `409` or `422`, required
context/authorization/evidence unavailability to retryable `503`, and caught unexpected defects to
a sanitized declared `500`. No adapter constructs an ad hoc response or exposes database or SpiceDB
diagnostics.
