import { Schema } from 'effect';

/** The owning worker has persisted unfinished work and requests a wake at its exact due time. */
export class OutboxWorkerDeferred extends Schema.TaggedError<OutboxWorkerDeferred>()('OutboxWorkerDeferred', {
  wakeAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}
