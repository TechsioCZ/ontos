import { Effect, Layer, Schema } from 'effect';

import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { defineOutboxWorkerEntry, startOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import { makeOutboxWorkerComposition, outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

const MessageKey = Schema.String.pipe(Schema.brand('MessageKey'));

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'process.fixture',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'process.fixture.lifecycle',
      moduleKey: 'process.fixture',
      role: 'worker',
    }),
    leaseDurationMs: 1000,
    payloadSchema: Schema.Struct({ messageKey: MessageKey }),
    producerModuleKey: 'producer.fixture',
    retryPolicy: {
      initialBackoffMs: 0,
      maxAttempts: 1,
      maxBackoffMs: 0,
      multiplier: 1,
    },
    topic: 'producer.fixture.message-created',
    workerKey: 'process.fixture.lifecycle',
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

const expectedDeployment = { appId: 'process-fixture', buildMarker: 'process-fixture-build' };
const subscriptions = extractOutboxWorkerSubscriptions([registration]);
const composition = makeOutboxWorkerComposition([
  {
    ...expectedDeployment,
    dependencies: ['producer.fixture'],
    moduleId: 'process.fixture',
    subscriptions,
  },
  { appId: 'producer-fixture', moduleId: 'producer.fixture' },
]);

startOutboxWorkerHost({
  entries: [
    defineOutboxWorkerEntry({
      claimOwnerPrefix: 'process-fixture',
      expectedDeployment,
      layer: runtimeLayer.pipe(Layer.merge(outboxWorkerCompositionLayer(composition))),
      registrations: [registration],
      subscriptions,
    }),
  ],
});
