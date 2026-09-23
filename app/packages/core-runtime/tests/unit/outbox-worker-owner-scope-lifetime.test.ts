import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineScopedRoutine, ScopedRoutineInvocationError } from '../../src/db/scoped-routine.ts';
import type { ScopedRoutineInvoker } from '../../src/db/scoped-routine.ts';
import {
  defineOutboxWorkerCompletion,
  OutboxWorkerCompletionPublicationError,
} from '../../src/outbox/completion-publication.ts';
import type { OutboxWorkerCompletionPublisher } from '../../src/outbox/completion-publication.ts';
import { lifetimeBoundOutboxWorkerOwnerCapabilities } from '../../src/outbox/worker-owner-scope-lifetime.ts';

const routine = defineScopedRoutine({
  name: 'finish_projection',
  ownerModuleKey: 'pricing.price-group-catalog',
  parameters: [{ source: 'tenantId', type: 'uuid' }],
  resultSchema: Schema.Struct({ applied: Schema.Boolean }),
  routineKey: 'price-group.finish-projection',
  schema: 'price_group_catalog',
});

const completion = defineOutboxWorkerCompletion({
  consumerModuleKey: 'pricing.price-group-catalog',
  eventType: 'pricing.price-group-catalog.price-group-created.v1',
  payloadSchema: Schema.Struct({ applied: Schema.Boolean }),
  producerModuleKey: 'pricing.price-group-catalog',
  topic: 'pricing.price-group-catalog.price-group-created.v1',
  workerKey: 'pricing.price-group-catalog.project-containment',
});
const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-23T10:00:00.000Z'));

it.effect('checks routine and completion lifetimes when deferred Effects execute', () =>
  Effect.gen(function* rejectLeakedCapabilities() {
    let completionCalls = 0;
    let routineCalls = 0;
    const routineInvoker: ScopedRoutineInvoker = {
      invoke: () =>
        Effect.sync(() => {
          routineCalls += 1;
          return [{ applied: true }];
        }),
    };
    const completionPublisher: OutboxWorkerCompletionPublisher = {
      publish: (_definition, input) =>
        Effect.sync(() => {
          completionCalls += 1;
          return { domainEventId: input.completionId, outcome: 'PUBLISHED' as const };
        }),
    };
    const capabilities = lifetimeBoundOutboxWorkerOwnerCapabilities(routineInvoker, completionPublisher);
    const deferredRoutine = capabilities.routineInvoker.invoke(routine, []);
    const deferredCompletion = capabilities.completionPublisher.publish(completion, {
      completionId: '10000000-0000-4000-8000-000000000001',
      occurredAt,
      payloadJson: { applied: true },
      sourceActionInvocationId: '20000000-0000-4000-8000-000000000002',
      subjectModuleKey: 'pricing.price-group-catalog',
      subjectResourceId: '30000000-0000-4000-8000-000000000003',
      subjectResourceType: 'price-group',
    });

    capabilities.close();
    const routineFailure = yield* Effect.flip(deferredRoutine);
    const completionFailure = yield* Effect.flip(deferredCompletion);
    expect(Schema.is(ScopedRoutineInvocationError)(routineFailure)).toBe(true);
    expect(Schema.is(OutboxWorkerCompletionPublicationError)(completionFailure)).toBe(true);
    expect(routineCalls).toBe(0);
    expect(completionCalls).toBe(0);
  }),
);
