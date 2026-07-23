# ADR-0003: State changes through Actions, side effects through events/outbox

Status: Proposed

## Context

Naive event-driven architecture can produce unpredictable state changes when synchronous subscribers mutate business state. The system must be understandable, auditable, and performant.

## Decision

Business state changes only through registered Actions implemented by Command Handlers. Successful commands record canonical state, audit events, domain events, and outbox messages in Postgres. Events and outbox messages trigger projections and integrations after commit.

## Consequences

Business correctness stays in commands. Events explain what happened. Outbox workers handle side effects such as Neo4j projection, search indexing, reporting refreshes, and accounting export preparation.

## Risks

The team must resist adding “quick” inline side effects in command handlers. Tests and code review should enforce the pattern.
