# Core Principal time-zone preference contract

## Purpose

This contract supplies the configured per-user IANA time zone required by Created time and Last edited time. It defines the shared Core boundary; it does not add datatype-specific configuration.

## Ownership and identity

- Core Principal Preferences owns the source of truth.
- A preference belongs to the tenant-scoped human Principal identified by `(tenantId, principalId)`. It does not belong to a Better Auth user or session, because authentication bindings are replaceable login infrastructure while the Principal is the durable Core identity used by the operation context.
- Ticketing and individual Task Property Definitions neither persist nor override the preference.

## Stored value and validation

- The configured value is one IANA time-zone identifier recognized by Core's supported time-zone database, such as `Europe/Prague` or `America/New_York`.
- Core validates and canonicalizes an accepted identifier before persistence. An unrecognized identifier is rejected and never replaces the prior configured value.
- Changing the preference affects subsequent presentation and local-calendar query interpretation. It never rewrites stored absolute instants.

## Governed read contract

Core exposes a Principal Preferences read operation equivalent to:

`resolveEffectiveTimeZone(operationContext, browserTimeZone?) -> { timeZone, source }`

- The operation derives `tenantId` and `principalId` from the authenticated `OperationContext`; callers cannot read another Principal by substituting identifiers.
- `source` is `configured`, `browser_fallback`, or `system_fallback`.
- Resolution order is: persisted configured preference; otherwise a valid browser-supplied IANA identifier; otherwise `UTC`.
- A browser-supplied identifier is only an initialization candidate or a fallback. It never overrides a persisted configured preference.
- Core may atomically initialize an absent preference from a valid browser candidate. Concurrent initialization is first-write-wins; a later explicit preference change uses the ordinary governed preference-write operation.
- Server-side local-day and local-range filters resolve the effective time zone once for the request and use that same identifier for all boundary calculations. Presentation clients use the same resolved result for that request/session.

## Authorization and lifecycle

- An authenticated human Principal may read and change its own preference through governed Core operations. Service, integration, agent, and system Principals have no personal browser preference and therefore resolve to the system fallback unless an explicitly governed Core use case later defines otherwise.
- Disabling or archiving a Principal retains its configured preference with the Principal record. It is unavailable for an unauthenticated or unauthorized request and becomes effective again if that Principal is reactivated.
- Signing out, replacing a session, or replacing an authentication binding does not reset the preference.

## Acceptance guarantees

- Two sessions for the same tenant-scoped Principal receive the same configured time zone after it has been set.
- A detected browser zone cannot overwrite an existing configured zone.
- With no configured value, `Europe/Prague` supplied by the browser resolves to `Europe/Prague`; with neither configured nor browser value, the result is `UTC`.
- The time zone used to render an instant and to interpret a local-calendar filter is visible in the resolved contract result and is not inferred independently by Ticketing.

## Sources

- `../sources/product-owner/ontos-created-time-property.md` §§F7–F10.
- `../sources/handoffs/ontos-created-time-property-handoff.md`.
- `../sources/handoffs/ontos-last-edited-time-handoff.md`.
- Existing Core boundaries: `packages/core-runtime/src/db/schema.ts`, `packages/core-runtime/src/operation-context.ts`, `packages/core-runtime/src/operation-context-from-session.ts`, and `packages/core-runtime/src/db/auth-schema.ts`.
