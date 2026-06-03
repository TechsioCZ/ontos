# ADR-0008: Module activation and state model

Status: Proposed

## Context

Tenants may have different modules enabled. Modules may need to be suspended, made read-only, quarantined, deprecated, or archived without deleting history. Legal-entity-specific differences are module configuration, not Core module activation.

## Decision

Installed MicroVertical code is deployed with the application. Runtime module state controls availability per tenant. States include active, read-only, suspended, quarantined, deprecated, and archived.

If a module is active for a tenant but only configured for some legal entities, the owning module stores that in its own settings tables, for example `RENTAL_SHORT_TERM_LEGAL_ENTITY_SETTINGS`.

## Consequences

Activation/deactivation can happen without restart for installed modules. New module code still requires deployment in V0. Historical data remains visible according to permissions even when a module is not active.

## Risks

Every Action, UI contribution, search descriptor, and report must respect tenant-level module state and any module-owned legal-entity setup. Missing checks can expose disabled functionality.
