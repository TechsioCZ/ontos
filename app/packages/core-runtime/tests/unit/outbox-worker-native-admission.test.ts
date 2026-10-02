import { Context, Deferred, Effect, Fiber, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { defineOutboxWorkerEntry } from '../../src/outbox/process.ts';
import type { OutboxClaim, OutboxRepositoryService } from '../../src/outbox/repository.ts';
import { makeOutboxRuntime, OutboxRuntime } from '../../src/outbox/runtime.ts';
import { makeOutboxWorkerComposition, outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

class NativeWorkerDependency extends Context.Service<
  NativeWorkerDependency,
  { readonly record: (context: OutboxWorkerHandlerContext) => void }
>()('@app/core-runtime/tests/unit/outbox-worker-native-admission.test/NativeWorkerDependency') {}

const expectedDeployment = { appId: 'worker-native-admission', buildMarker: 'worker-native-admission-build' };
const retryPolicy = { initialBackoffMs: 0, maxAttempts: 1, maxBackoffMs: 0, multiplier: 1 } as const;
const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'worker.native-admission',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'worker.native-admission.projector',
      moduleKey: 'worker.native-admission',
      role: 'worker',
    }),
    leaseDurationMs: 1000,
    payloadSchema: Schema.Struct({ messageKey: Schema.String.pipe(Schema.brand('MessageKey')) }),
    producerModuleKey: 'producer.native-admission',
    retryPolicy,
    topic: 'producer.native-admission.message-created',
    workerKey: 'worker.native-admission.projector',
  },
  (_payload, context) =>
    NativeWorkerDependency.pipe(Effect.flatMap(({ record }) => Effect.sync(() => record(context)))),
);
const subscriptions = extractOutboxWorkerSubscriptions([registration]);
const composition = makeOutboxWorkerComposition([
  {
    ...expectedDeployment,
    dependencies: ['producer.native-admission'],
    moduleId: 'worker.native-admission',
    subscriptions,
  },
  { appId: 'producer-native-admission', moduleId: 'producer.native-admission' },
]);

for (const mutateCallerInput of [false, true]) {
  it.effect(
    mutateCallerInput
      ? 'caller subscription array and scalar changes cannot replace the admitted native worker catalog'
      : 'an approved worker entry reaches claiming and its owner handler through the native Outbox runtime',
    () =>
      Effect.gen(function* nativeWorkerAdmission() {
        const firstCycle = yield* Deferred.make<'failed' | 'succeeded'>();
        const claimRevisions: string[] = [];
        const handled: OutboxWorkerHandlerContext[] = [];
        const completed: OutboxClaim[] = [];
        const selected: OutboxClaim = {
          attemptId: 'attempt-1',
          attemptNumber: 1,
          claimId: 'native-admission:claim-1',
          consumerModuleKey: registration.descriptor.consumerModuleKey,
          deliveryId: 'delivery-1',
          domainEventId: 'event-1',
          messageId: 'message-1',
          payloadJson: { messageKey: 'message-1' },
          producerModuleKey: registration.descriptor.producerModuleKey,
          retryPolicy,
          tenantId: '10000000-0000-4000-8000-000000000001',
          tenantSequenceNo: 1n,
          topic: registration.descriptor.topic,
          workerKey: registration.descriptor.workerKey,
        };
        const pending = [selected];
        const repository: OutboxRepositoryService = {
          claimNext: (_registrations, _claimOwner, _now, revision) =>
            Effect.sync(() => {
              claimRevisions.push(revision);
              return Option.fromNullishOr(pending.shift());
            }),
          complete: (claim) => Effect.sync(() => completed.push(claim)).pipe(Effect.asVoid),
          fail: () => Effect.die('A valid native worker must complete its claimed delivery'),
          matchUnmatched: () => Effect.die('Owner polling must not perform global matching'),
        };
        const callerSubscriptions = subscriptions.map((subscription) => ({ ...subscription }));
        const entry = defineOutboxWorkerEntry({
          claimOwnerPrefix: 'native-admission',
          expectedDeployment,
          layer: Layer.mergeAll(
            Layer.succeed(OutboxRuntime, makeOutboxRuntime(repository)),
            Layer.succeed(NativeWorkerDependency, {
              record: (context) => {
                handled.push(context);
              },
            }),
            outboxWorkerCompositionLayer(composition),
          ),
          registrations: [registration],
          subscriptions: callerSubscriptions,
        });
        if (mutateCallerInput) {
          for (const subscription of callerSubscriptions) {
            subscription.producerModuleKey = 'another.producer';
            subscription.topic = 'another.producer.message-created';
            subscription.workerKey = 'worker.native-admission.another-projector';
          }
          callerSubscriptions.splice(0);
        }
        const running = yield* entry
          .runLoop({
            config: { claimOwner: 'native-admission:test', maxDeliveries: 1, pollIntervalMs: 10 },
            health: {
              cycleFailed: Deferred.succeed(firstCycle, 'failed').pipe(Effect.asVoid),
              cycleSucceeded: Deferred.succeed(firstCycle, 'succeeded').pipe(Effect.asVoid),
            },
          })
          .pipe(Effect.forkChild);
        const outcome = yield* Deferred.await(firstCycle).pipe(Effect.raceFirst(Fiber.join(running)));
        yield* Fiber.interrupt(running);

        expect(outcome).toBe('succeeded');
        expect(claimRevisions).toEqual([composition.revision]);
        expect(completed).toEqual([selected]);
        expect(handled).toHaveLength(1);
        expect(handled[0]).toMatchObject({
          compositionRevision: composition.revision,
          consumerModuleKey: registration.descriptor.consumerModuleKey,
          messageId: selected.messageId,
          workerKey: registration.descriptor.workerKey,
        });
      }),
  );
}
