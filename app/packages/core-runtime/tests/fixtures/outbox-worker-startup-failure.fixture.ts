import { Effect, Layer, Schema } from 'effect';

import { startOutboxWorkerProcess } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';

class WorkerDatabaseUnreachable extends Schema.TaggedError<WorkerDatabaseUnreachable>()('WorkerDatabaseUnreachable', {
  message: Schema.String,
}) {}

startOutboxWorkerProcess({
  claimOwnerPrefix: 'startup-failure-fixture',
  layer: Layer.effect(
    OutboxRuntime,
    Effect.fail(new WorkerDatabaseUnreachable({ message: 'DATABASE_URL is not a PostgreSQL URL' })),
  ),
  registrations: [],
  subscriptions: [],
});
