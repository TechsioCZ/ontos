# ADR-0013: Broadcast outbox deliveries

Status: Proposed

## Context

Outbox Messages may be broadcast facts that multiple MicroVertical-owned Outbox Workers consume independently. A single global message status cannot represent that Storage succeeded while Accounting failed for the same message.

## Decision

Keep Outbox Messages as immutable broadcast sources and add per-worker delivery state. The OntOS Worker Runtime matches each unmatched Outbox Message once against the Outbox Worker descriptors registered at that time, creates one delivery row per match, and records `matchedAt` on the message. `matchedAt` is the durable marker that message-to-worker matching already happened, including the valid case where zero workers matched. New Outbox Workers do not automatically backfill messages that were already matched in V0.

## Consequences

One message can be processed independently by multiple Outbox Workers with separate retries, attempts, and dead-letter state. Message matching is deterministic and idempotent at first observation, and backfilling historical messages remains an explicit future operation rather than an accidental side effect of deploying a new worker.
