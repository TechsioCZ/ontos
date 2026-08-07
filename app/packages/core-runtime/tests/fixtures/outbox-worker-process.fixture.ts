import { Effect, Layer, Schema } from 'effect';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { startOutboxWorkerProcess } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'process-fixture',
    leaseDurationMs: 1000,
    payloadSchema: Schema.Struct({ messageKey: Schema.String }),
    producerModuleKey: 'producer',
    retryPolicy: {
      initialBackoffMs: 0,
      maxAttempts: 1,
      maxBackoffMs: 0,
      multiplier: 1,
    },
    topic: 'producer.message-created',
    workerKey: 'process-fixture.lifecycle',
  },
  () => Effect.void,
);

const runtimeLayer = Layer.effect(
  OutboxRuntime,
  Effect.acquireRelease(
    Effect.succeed({
      matchMessages: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
      runCycle: () =>
        Effect.sync(() => {
          process.stdout.write(`cycle:${process.listenerCount('SIGTERM')}\n`);
          return {
            claimed: 0,
            dead: 0,
            deliveriesCreated: 0,
            failed: 0,
            messagesMatched: 0,
            retried: 0,
            succeeded: 0,
          } as const;
        }),
    }),
    () =>
      Effect.sync(() => {
        process.stdout.write('disposed\n');
      }),
  ),
);

startOutboxWorkerProcess({
  claimOwnerPrefix: 'process-fixture',
  layer: runtimeLayer,
  registrations: [registration],
  subscriptions: [registration.descriptor],
});
