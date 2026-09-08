import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect, Schema } from 'effect';
import { PartySearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { PartySearchProjector } from '../../src/services/party-search-projection.service.ts';
import { definePartySearchWorker } from '../../src/workers/party-search-worker.ts';

const context: OutboxWorkerHandlerContext = {
  attemptNumber: 2,
  claimId: 'claim',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'party.registry',
  tenantId: 'tenant',
  tenantSequenceNo: 7n,
  topic: 'party.registry.worker-test.v1',
  workerKey: 'party.registry.worker-test',
};
const TestResourceIdSchema = Schema.String.pipe(Schema.brand('SearchWorkerTestResourceId'));
const payloadSchema = Schema.Struct({ resourceId: TestResourceIdSchema });
const entrypoint = defineTenantModuleEntrypoint({
  access: 'background',
  authorization: { kind: 'owner_local_background' },
  entrypointKey: context.workerKey,
  moduleKey: 'party.registry',
  role: 'worker',
});

for (const targetField of ['partyId', 'counterpartyId'] as const) {
  test(`search worker forwards ${targetField}, trusted context, and typed retryable failure`, () =>
    runEffectTestPromise(
      Effect.gen(function* forwardsSearchProjection() {
        const { handle, worker } = definePartySearchWorker(
          {
            entrypoint,
            payloadSchema,
            producerModuleKey: 'party.registry',
            topic: context.topic,
          },
          {
            spanName: 'PartySearchWorkerTest',
            target: (payload) =>
              targetField === 'partyId'
                ? { partyId: payload.resourceId }
                : { counterpartyId: payload.resourceId },
          },
        );
        assert.deepEqual(worker.descriptor, {
          consumerModuleKey: 'party.registry',
          entrypoint,
          leaseDurationMs: 30_000,
          payloadSchema,
          producerModuleKey: 'party.registry',
          retryPolicy: {
            initialBackoffMs: 1000,
            maxAttempts: 5,
            maxBackoffMs: 60_000,
            multiplier: 2,
          },
          topic: context.topic,
          workerKey: context.workerKey,
        });
        const failure = new PartySearchProjectionUnavailable({
          code: 'party_search_projection_unavailable',
          reason: 'retry this projection',
        });
        let calls = 0;
        const result = yield* handle(
          { resourceId: yield* Schema.decodeUnknownEffect(TestResourceIdSchema)('target') },
          context,
        ).pipe(
          Effect.provideService(PartySearchProjector, {
            project: (receivedContext, target) => {
              calls += 1;
              assert.equal(receivedContext, context);
              assert.deepEqual(target, { [targetField]: 'target' });
              return Effect.fail(failure);
            },
          }),
          Effect.catchTag('PartySearchProjectionUnavailable', (error) => Effect.succeed(error)),
        );
        assert.equal(result, failure);
        assert.equal(calls, 1);
      }),
    ));
}
