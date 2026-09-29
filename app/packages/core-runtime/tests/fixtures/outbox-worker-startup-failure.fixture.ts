import { Effect, Layer, Schema } from 'effect';

import { defineOutboxWorkerEntry, startOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';

class WorkerDatabaseUnreachable extends Schema.TaggedError<WorkerDatabaseUnreachable>()('WorkerDatabaseUnreachable', {
  message: Schema.String,
}) {}

startOutboxWorkerHost({
  entries: [
    defineOutboxWorkerEntry({
      claimOwnerPrefix: 'startup-failure-fixture',
      // The runtime fails to connect, and releasing what it already acquired dies as well.
      layer: Layer.effect(
        OutboxRuntime,
        Effect.addFinalizer(() => Effect.die('pool close failed for ontos_runtime')).pipe(
          Effect.andThen(
            Effect.fail(
              new WorkerDatabaseUnreachable({ message: 'password authentication failed for user ontos_runtime' }),
            ),
          ),
        ),
      ),
      registrations: [],
      subscriptions: [],
    }),
  ],
});
