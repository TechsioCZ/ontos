# ADR-0005: BetterAuth + SpiceDB + OntOS Policy Layer

Status: Accepted

## Context

The system needs authentication, sessions, multi-tenant/user DX, relationship-based authorization, and business-specific policy checks. Custom authorization logic spread through application code is too easy to get wrong, especially across tenants, legal entities, modules, and sensitive records. One tool should not be forced to solve all of these.

## Decision

BetterAuth handles authentication and session DX. OntOS maps authenticated users into principals. SpiceDB handles coarse, security-critical relationship-based authorization: tenant membership, legal-entity roles, module access, admin/support powers, accounting/export powers, and explicit grants to sensitive resources. OntOS Policy Layer handles business policies such as module state, locked periods, invoice already exported, amount thresholds, and approval requirements.

## Consequences

Authn, authz, and business policy remain separate. SpiceDB should not mirror the entire company ontology graph. Business relations and authorization relations are related but distinct.

## Risks

SpiceDB can still become too heavy if the schema is over-modeled. V0 must keep the schema deliberately small and validate latency, consistency behavior, and search-filtering strategy early.
