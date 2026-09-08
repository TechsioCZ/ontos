# ADR-0008: Module activation and state model

Status: Partially superseded by [ADR-0016](0016-independently-deployable-microverticals.md).

The state vocabulary and fail-closed entrypoint gate remain accepted. ADR-0016 replaced the
original deployment and registration assumptions. Current mechanics live in
[`app/docs/architecture/MODULE_ENTRYPOINTS.md`](../../app/docs/architecture/MODULE_ENTRYPOINTS.md)
and [`MODULE_MANIFESTS.md`](../../app/docs/architecture/MODULE_MANIFESTS.md).

## Context

Tenants may have different modules enabled. Modules may need to be inactive, suspended, made
read-only, quarantined, deprecated, or archived without deleting history. Legal-entity-specific
differences are module configuration, not Core module activation.

## Decision still in force

Runtime module state controls availability per tenant. States include inactive, active,
read-only, suspended, quarantined, deprecated, and archived.

If a module is active for a tenant but configured for only some legal entities, the owning module
stores that distinction in its settings, for example
`RENTAL_SHORT_TERM_LEGAL_ENTITY_SETTINGS`.

Every module entrypoint passes through Shell/Core so the Module State Gate can fail closed before
private module code loads or runs. Direct entrypoint loading is forbidden, including raw Module
Federation `loadRemote(...)` calls outside the gateway and direct imports of private routes,
components, Action handlers, or Worker handlers. Shell/Core uses structured entrypoints keyed by
module identity and role rather than raw remote specifier strings.

## Superseded deployment detail

The original decision assumed installed MicroVertical code shipped with one application and that
new module code required that application's deployment. ADR-0016 replaced that assumption with
independently deployable MicroVertical seams and serialized deployment contracts.

## Consequences

Tenant state can change without deleting history or redeploying an already installed module.
Physical deployment follows ADR-0016; tenant installation and activation remain separate.

## Risks

Every Action, UI contribution, search descriptor, report, public component, and Worker dispatch
must respect tenant module state and any module-owned legal-entity setup. Missing checks can expose
disabled functionality. Entrypoints must remain mapped through Shell/Core-owned metadata rather
than raw private specifiers at call sites.
