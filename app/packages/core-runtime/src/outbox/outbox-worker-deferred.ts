import { Schema } from 'effect';

/** The owning worker has persisted unfinished work and requests a wake at its exact due time. */
export class OutboxWorkerDeferred extends Schema.TaggedError<OutboxWorkerDeferred>()('OutboxWorkerDeferred', {
  wakeAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/**
 * What the Outbox records on the attempt a deferral settles, so a reader can tell a wake its owner asked for from a
 * retry backoff after a failure.
 */
export const OUTBOX_DEFERRED_ATTEMPT_MESSAGE = 'Outbox Worker deferred until its durable due time';
