# ADR-0008: Module activation and state model

Status: Proposed

## Context

Tenants and legal entities may have different modules enabled. Modules may need to be suspended, made read-only, quarantined, deprecated, or archived without deleting history.

## Decision

Installed MicroVertical code is deployed with the application. Runtime module installation state controls availability per tenant/legal entity. States include active, read-only, suspended, quarantined, deprecated, and archived.

## Consequences

Activation/deactivation can happen without restart for installed modules. New module code still requires deployment in V0. Historical data remains visible according to permissions even when a module is not active.

## Risks

Every Action, UI contribution, search descriptor, and report must respect module state. Missing checks can expose disabled functionality.
