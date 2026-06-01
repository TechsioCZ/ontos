# Runtime and consistency model

OntOS should use an action-driven core with evented side effects. This avoids the main failure mode of naive event-driven ERP architecture: business state changing unpredictably through subscriber chains.

## Write flow

A user, API consumer, import, integration, or later agent invokes a registered Action. The runtime resolves the authenticated principal, tenant context, legal-entity context, module state, authorization, and policy checks before running the Command Handler.

The Command Handler writes canonical state to Postgres in a transaction. When the action changes business state, the same transaction should record the relevant audit event, domain event, and outbox message. After commit, workers process outbox messages and update derived read models or external outputs.

## Why actions before events

A business action is intentional and authorized. A domain event is a record that something happened. If events become the primary mechanism for state changes, the architecture becomes difficult to reason about: subscriber order matters, side effects become hidden, and performance degrades through synchronous fan-out.

For V0, business correctness should live in actions and command handlers. Events are used for history and side effects.

## Domain events

Domain events should be named as past-tense business facts. Examples: lease contract created, reservation cancelled, invoice issued, payment matched, document attached, entity linked, module suspended. They should have small, versioned payloads and reference entities rather than embedding full object snapshots by default.

Domain events are useful for timeline, audit-adjacent explanations, projection triggers, reporting refreshes, and future analytics. They are not a substitute for domain tables.

## Audit events

Audit events capture evidence: actor, principal kind, tenant, legal entity, action, target resource, permission decision, policy decision, before/after summary where needed, request metadata, and timestamp. Audit must be reliable and queryable because both the business and delivery process require traceability.

Audit events are not workflow triggers. They are evidence records.

## Outbox messages

Outbox messages are technical delivery records. They are written transactionally with canonical data so that side effects are not lost when a process crashes between database write and external notification.

Outbox workers handle Neo4j projection, search projection, reporting refresh, accounting export preparation, future notifications, and future integration events. Handlers must be idempotent, retryable, observable, and capable of dead-lettering.

## Synchronous vs asynchronous work

Synchronous action execution should include authentication, authorization, policy checks, validation, canonical Postgres writes, audit/domain/outbox recording, and small local derived values. It should not include external API calls, Neo4j writes, search indexing, report recomputation, email/SMS delivery, or heavy imports.

Asynchronous workers should handle all side effects that can be retried or rebuilt. The user-facing action should return once canonical state is committed.

## Consistency levels

Operational ERP state is strongly consistent inside Postgres transactions. Graph, search, reporting, and integration projections are eventually consistent. The UI must be honest about this when necessary. For example, a graph view can show projection freshness or lag if relevant.

The architecture must tolerate projection failures. A failed Neo4j projection should not invalidate a created invoice. A failed accounting export worker should leave an export batch in a failed state for retry, not roll back the original invoice unless that was explicitly modeled as a reversible business action.

## Performance guardrails

The first implementation should include guardrails rather than assuming performance will be fine. Useful early measurements include API p95/p99 latency, DB query count per request, slow queries, event loop delay, SpiceDB check latency, outbox lag, worker duration, Neo4j projection lag, and search latency.

The runtime should avoid unbounded relation expansion, unbounded synchronous subscribers, per-result authorization calls in large search result sets, large event payloads, and heavy work inside request handlers.
