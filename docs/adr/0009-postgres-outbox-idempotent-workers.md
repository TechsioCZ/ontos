# ADR-0009: Postgres outbox and idempotent workers

Status: Accepted

## Context

The system must write canonical state and trigger projections/integrations without dual-write inconsistency. Inline external side effects would make user-facing actions slow and fragile.

## Decision

Use a Postgres outbox table written in the same transaction as business changes. Worker runtime processes outbox messages idempotently and handles retries, failures, and dead-letter states.

## Consequences

Neo4j, search, reporting, and exports become eventually consistent and replayable. User-facing commands remain focused on canonical writes.

## Risks

Outbox lag must be observable. Handlers must be idempotent. Without metrics, projection failures could go unnoticed.
