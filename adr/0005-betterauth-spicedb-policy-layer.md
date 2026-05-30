# ADR-0005: BetterAuth + SpiceDB + TERP Policy Layer

Status: Proposed

## Context

The system needs authentication, sessions, multi-tenant/user DX, relationship-based authorization, and business-specific policy checks. One tool should not be forced to solve all of these.

## Decision

BetterAuth handles authentication and session DX. TERP maps authenticated users into principals. SpiceDB handles relationship-based authorization. TERP Policy Layer handles business policies such as module state, locked periods, invoice already exported, amount thresholds, and approval requirements.

## Consequences

Authn, authz, and business policy remain separate. SpiceDB should not mirror the entire company ontology graph. Business relations and authorization relations are related but distinct.

## Risks

SpiceDB may be too heavy for V0 if the schema is over-modeled. The PoC must validate minimum useful schema and latency.
