import {
  scopedRoutineInvokerFromTransaction,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import {
  OutboxWorkerLegalEntityScopeFanout,
  ResourceContainmentMutationUnavailable,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime/outbox/worker';
import type {
  OutboxWorkerHandlerContext,
  OutboxWorkerLegalEntityScope,
  ResourceContainmentRelationshipMutationInput,
} from '@app/core-runtime/outbox/worker';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OutboxPayloadSchema as MarketCreatedPayloadSchema } from '../../shared/outbox/commerce-market-catalog-market-created-v1.ts';
import { OutboxPayloadSchema as StorefrontAssociatedPayloadSchema } from '../../shared/outbox/commerce-market-catalog-storefront-associated-v1.ts';
import { handleProjectAssociationContainment } from '../../src/workers/project-association-containment.worker.ts';
import { handleProjectMarketContainment } from '../../src/workers/project-market-containment.worker.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '33333333-3333-4333-8333-333333333333';
const otherCompanyId = '44444444-4444-4444-8444-444444444444';
const marketId = '55555555-5555-4555-8555-555555555555';
const definitionRevisionId = '66666666-6666-4666-8666-666666666666';
const associationId = '88888888-8888-4888-8888-888888888888';
const january = '2030-01-01T00:00:00.000Z';
const moduleId = 'commerce.market-catalog';

const marketRef = { moduleId, resourceId: marketId, resourceType: 'commerce.market-catalog.market', tenantId } as const;
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const definitionRevisionRef = {
  moduleId,
  resourceId: definitionRevisionId,
  resourceType: 'commerce.market-catalog.market-definition-revision',
  tenantId,
} as const;
const associationRef = {
  moduleId,
  resourceId: associationId,
  resourceType: 'commerce.market-catalog.storefront-association',
  tenantId,
} as const;
const storefrontRef = { appId: 'akros-storefront', tenantId } as const;

const history = {
  associations: [
    {
      associationRef,
      channel: 'B2C',
      effectivePeriod: { startsAt: january },
      marketDefinitionRevisionRef: definitionRevisionRef,
      marketRef,
      provenance: { kind: 'CONFIGURATION_ACTION', reference: 'fixture:v1' },
      revision: 1,
      sellingLegalEntityRef: sellerRef,
      storefrontRef,
    },
  ],
  definitions: [
    {
      channels: ['B2C'],
      definitionRevisionRef,
      effectivePeriod: { startsAt: january },
      jurisdictions: [{ code: 'SK', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'AKROS-SK',
      marketRef,
      purpose: 'Maloobchodní prodej na Slovensku',
      revision: 1,
      sellingLegalEntityRef: sellerRef,
      supportedLocales: ['sk'],
    },
  ],
  marketRef,
};

const marketCreated = Schema.decodeUnknownSync(MarketCreatedPayloadSchema)({
  channels: ['B2C'],
  definitionRevisionRef,
  effectivePeriod: { startsAt: january },
  lifecycle: 'ACTIVE',
  marketRef,
  revision: 1,
  sellingLegalEntityRef: sellerRef,
});
const storefrontAssociated = Schema.decodeUnknownSync(StorefrontAssociatedPayloadSchema)({
  associationRef,
  channel: 'B2C',
  effectivePeriod: { startsAt: january },
  marketRef,
  revision: 1,
  storefrontRef,
});

const handlerContext = (workerKey: string, topic: string): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: '99999999-9999-4999-8999-999999999991',
    compositionRevision: 'c'.repeat(64),
    consumerModuleKey: moduleId,
    deliveryId: '99999999-9999-4999-8999-999999999992',
    domainEventId: '99999999-9999-4999-8999-999999999993',
    legalEntityScope: 'required',
    messageId: '99999999-9999-4999-8999-999999999994',
    producerModuleKey: moduleId,
    tenantId,
    tenantSequenceNo: 1n,
    topic,
    workerKey,
  });

/** One fan-out scope per company; only the seller's scope sees the Market row (owner RLS). */
const fanoutWith = (rowsByLegalEntity: ReadonlyMap<string, typeof history | null>) =>
  Layer.succeed(
    OutboxWorkerLegalEntityScopeFanout,
    OutboxWorkerLegalEntityScopeFanout.of({
      forEachScope: (_context, observe) =>
        Effect.forEach(
          [...rowsByLegalEntity],
          ([legalEntityId, payload]) => {
            const routineInvoker = scopedRoutineInvokerFromTransaction(
              () => Effect.succeed(payload === null ? [] : [{ payload }]),
              { legalEntityId, tenantId },
            );
            const scope: OutboxWorkerLegalEntityScope = {
              completionPublisher: { publish: () => Effect.die('The containment projection publishes no completion') },
              legalEntityId,
              routineInvoker,
              tenantId,
            };
            return observe(scope);
          },
          { discard: true },
        ),
    }),
  );

const recordingMutation = () => {
  const touches: ResourceContainmentRelationshipMutationInput[] = [];
  const layer = Layer.succeed(
    ResourceContainmentRelationshipMutation,
    ResourceContainmentRelationshipMutation.of({
      touch: (input) =>
        Effect.sync(() => {
          touches.push(input);
        }),
    }),
  );
  return { layer, touches };
};

describe('Market resource containment projection', () => {
  it.effect('places a created Market in its seller company Market module scope', () =>
    Effect.gen(function* placesCreatedMarket() {
      const { layer, touches } = recordingMutation();
      yield* handleProjectMarketContainment(
        marketCreated,
        handlerContext(
          'commerce.market-catalog.project-market-containment',
          'commerce.market-catalog.market-created.v1',
        ),
      ).pipe(
        Effect.provide(
          Layer.merge(
            fanoutWith(
              new Map([
                [otherCompanyId, null],
                [sellerId, history],
              ]),
            ),
            layer,
          ),
        ),
      );
      expect(touches).toEqual([
        {
          relationships: [
            {
              container: {
                objectId: toModuleAccessObjectId(tenantId, sellerId, moduleId),
                objectType: 'module_access',
              },
              relation: 'module',
              resource: { objectId: toResourceAccessObjectId(tenantId, sellerId, marketRef), objectType: 'resource' },
            },
          ],
        },
      ]);
    }),
  );

  it.effect('places a new Storefront Association in the scope of its Market', () =>
    Effect.gen(function* placesAssociation() {
      const { layer, touches } = recordingMutation();
      yield* handleProjectAssociationContainment(
        storefrontAssociated,
        handlerContext(
          'commerce.market-catalog.project-association-containment',
          'commerce.market-catalog.storefront-associated.v1',
        ),
      ).pipe(Effect.provide(Layer.merge(fanoutWith(new Map([[sellerId, history]])), layer)));
      expect(touches.map(({ relationships }) => relationships[0].resource.objectId)).toEqual([
        toResourceAccessObjectId(tenantId, sellerId, associationRef),
      ]);
    }),
  );

  it.effect('rejects a delivery whose seller or association does not match durable owner state', () =>
    Effect.gen(function* rejectsMismatches() {
      const { layer, touches } = recordingMutation();
      const foreignSeller = yield* Effect.flip(
        handleProjectMarketContainment(
          {
            ...marketCreated,
            sellingLegalEntityRef: { ...marketCreated.sellingLegalEntityRef, resourceId: otherCompanyId },
          },
          handlerContext(
            'commerce.market-catalog.project-market-containment',
            'commerce.market-catalog.market-created.v1',
          ),
        ).pipe(Effect.provide(Layer.merge(fanoutWith(new Map([[sellerId, history]])), layer))),
      );
      const unknownAssociation = yield* Effect.flip(
        handleProjectAssociationContainment(
          { ...storefrontAssociated, storefrontRef: { ...storefrontRef, appId: 'other-storefront' } },
          handlerContext(
            'commerce.market-catalog.project-association-containment',
            'commerce.market-catalog.storefront-associated.v1',
          ),
        ).pipe(Effect.provide(Layer.merge(fanoutWith(new Map([[sellerId, history]])), layer))),
      );
      const missingMarket = yield* Effect.flip(
        handleProjectMarketContainment(
          marketCreated,
          handlerContext(
            'commerce.market-catalog.project-market-containment',
            'commerce.market-catalog.market-created.v1',
          ),
        ).pipe(Effect.provide(Layer.merge(fanoutWith(new Map([[sellerId, null]])), layer))),
      );
      expect(
        [foreignSeller, unknownAssociation, missingMarket].every((failure) =>
          Predicate.isTagged(failure, 'MarketResourceContainmentRejected'),
        ),
      ).toBe(true);
      expect(touches).toHaveLength(0);
    }),
  );

  it.effect('keeps a SpiceDB outage retryable without claiming success', () =>
    Effect.gen(function* keepsOutageRetryable() {
      const failure = yield* Effect.flip(
        handleProjectMarketContainment(
          marketCreated,
          handlerContext(
            'commerce.market-catalog.project-market-containment',
            'commerce.market-catalog.market-created.v1',
          ),
        ).pipe(
          Effect.provide(
            Layer.merge(
              fanoutWith(new Map([[sellerId, history]])),
              Layer.succeed(
                ResourceContainmentRelationshipMutation,
                ResourceContainmentRelationshipMutation.of({
                  touch: () =>
                    Effect.fail(new ResourceContainmentMutationUnavailable({ reason: 'SpiceDB unavailable' })),
                }),
              ),
            ),
          ),
        ),
      );
      expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    }),
  );
});
