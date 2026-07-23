# ADR-0008: Module activation and state model

Status: Proposed

## Context

Tenants may have different modules enabled. Modules may need to be inactive, suspended, made read-only, quarantined, deprecated, or archived without deleting history. Legal-entity-specific differences are module configuration, not Core module activation.

## Decision

Installed MicroVertical code is deployed with the application. Runtime module state controls availability per tenant. States include inactive, active, read-only, suspended, quarantined, deprecated, and archived.

If a module is active for a tenant but only configured for some legal entities, the owning module stores that in its own settings tables, for example `RENTAL_SHORT_TERM_LEGAL_ENTITY_SETTINGS`.

All module entrypoints must be invoked through Shell/Core gateways so the Module State Gate can fail closed before loading or dispatching module code. Direct entrypoint loading is forbidden, including raw Module Federation `loadRemote(...)` calls outside the Shell/Core gateway and direct imports of private route, component, Action handler, or worker handler entrypoints. Shell/Core should use structured entrypoints keyed by module identity and entrypoint role rather than passing raw remote specifier strings through application code.

## Consequences

Activation/deactivation can happen without restart for installed modules. New module code still requires deployment in V0. Historical data remains visible according to permissions even when a module is not active.

## Risks

Every Action, UI contribution, search descriptor, report, public component, and worker dispatch must respect tenant-level module state and any module-owned legal-entity setup. Missing checks can expose disabled functionality. Module Federation loads should be mapped through Shell/Core-owned entrypoint metadata rather than raw remote specifier strings at call sites.
