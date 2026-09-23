import {
  BusinessPermissionCodeSchema,
  ScopedRoutineInvocationError,
  toBusinessPermissionAccessObjectId,
} from '@app/core-runtime';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import {
  OutboxWorkerTenantScope,
  ResourceContainmentMutationUnavailable,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime/outbox/worker';
import type {
  OutboxWorkerCompletionInput,
  OutboxWorkerHandlerContext,
  OutboxWorkerTenantScopeService,
  ResourceContainmentRelationshipMutationInput,
  ResourceContainmentRelationshipMutationService,
} from '@app/core-runtime/outbox/worker';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PriceGroupContainmentProjectionRequestedPayloadSchema } from '../../shared/actions/create-price-group.ts';
import { PriceGroupDefinitionRevisionSchema } from '../../shared/domain/price-group.ts';
import { PriceGroupContainmentProjectionPersistenceUnavailable } from '../../src/persistence/containment-projection-errors.ts';
import {
  handleReconcilePriceGroupContainmentProjection,
  priceGroupContainmentRelationships,
  ReconcilePriceGroupContainmentProjectionRejected,
} from '../../src/workers/reconcile-price-group-containment-projection.worker.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceGroupId = '22222222-2222-4222-8222-222222222222';
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const mutationId = '44444444-4444-4444-8444-444444444444';
const actionInvocationId = '55555555-5555-4555-8555-555555555555';
const completedAt = '2026-09-23T15:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const pricingCatalogRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: tenantId,
  resourceType: 'pricing.price-group-catalog.price-group-catalog-root',
  tenantId,
} as const;
const request = Schema.decodeUnknownSync(PriceGroupContainmentProjectionRequestedPayloadSchema)({
  catalogVersion: '1',
  mutationId,
  operation: 'touch_containment',
  priceGroupRef,
  pricingCatalogRef,
  schemaVersion: '1',
});
const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 1,
  classificationPurpose: 'Classifies customers eligible for dealer pricing.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
  created: {
    actionInvocationId,
    actorPrincipalId: '66666666-6666-4666-8666-666666666666',
    reason: 'Approved initial definition.',
    trustedAt: '2026-09-23T14:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Dealer pricing classification.',
  displayName: 'Dealer',
  effectivePeriod: { effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: null },
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
});
const pendingIntent = {
  ...request,
  completedAt: null,
  definition,
  requestedAt: definition.created.trustedAt,
  sourceActionInvocationId: actionInvocationId,
  state: 'PENDING' as const,
};
const completedIntent = { ...pendingIntent, completedAt, state: 'APPLIED' as const };
type CompletionInput = OutboxWorkerCompletionInput<unknown>;
interface ObservedWorkerEffects {
  readonly completions: CompletionInput[];
  readonly routineNames: string[];
  readonly touches: ResourceContainmentRelationshipMutationInput[];
}
const observeWorkerEffects = (): ObservedWorkerEffects => ({ completions: [], routineNames: [], touches: [] });
const context = {
  attemptNumber: 1,
  claimId: 'claim-1',
  consumerModuleKey: 'pricing.price-group-catalog',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  producerModuleKey: 'pricing.price-group-catalog',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'pricing.price-group.containment-projection-requested',
  workerKey: 'pricing.price-group-catalog.reconcile-price-group-containment-projection',
} satisfies OutboxWorkerHandlerContext;

it.effect('builds the exact six permission-scoped tenant and catalog containment tuples', () =>
  Effect.gen(function* buildExactContainment() {
    const relationships = yield* priceGroupContainmentRelationships(request);
    expect(relationships).toHaveLength(6);
    expect(relationships.map(({ relation }) => relation)).toEqual([
      'tenant',
      'containing_catalog',
      'tenant',
      'containing_catalog',
      'tenant',
      'containing_catalog',
    ]);
    expect(relationships.some(({ relation }) => relation === 'grantee')).toBe(false);
    const permissions = [
      'pricing.price_group.read',
      'pricing.price_group.revision.create',
      'pricing.price_group.retire',
    ].map((permission) => BusinessPermissionCodeSchema.make(permission));
    const expected = permissions.flatMap((permission) => {
      const group = toBusinessPermissionAccessObjectId(permission, {
        kind: 'price_group',
        priceGroupId,
        pricingCatalogId: tenantId,
        tenantId,
      });
      const catalog = toBusinessPermissionAccessObjectId(permission, {
        kind: 'pricing_catalog',
        pricingCatalogId: tenantId,
        tenantId,
      });
      return [
        {
          container: { objectId: tenantId, objectType: 'tenant' },
          relation: 'tenant',
          resource: { objectId: group, objectType: 'business_permission' },
        },
        {
          container: { objectId: catalog, objectType: 'business_permission' },
          relation: 'containing_catalog',
          resource: { objectId: group, objectType: 'business_permission' },
        },
      ];
    });
    expect(relationships).toEqual(expected);
  }),
);

const runHandler = (
  touch: ResourceContainmentRelationshipMutationService['touch'],
  observed: ObservedWorkerEffects,
  options: {
    readonly completeFails?: boolean;
    readonly handlerContext?: OutboxWorkerHandlerContext;
    readonly loadedIntent?: typeof pendingIntent | typeof completedIntent;
    readonly publishedCompletionIds?: Set<string>;
  } = {},
) => {
  const invoker: ScopedRoutineInvoker = {
    invoke: (routine) => {
      observed.routineNames.push(routine.name);
      if (routine.name === 'read_price_group_containment_projection_intent') {
        return Effect.succeed([{ payload: { _tag: 'found', intent: options.loadedIntent ?? pendingIntent } }]);
      }
      return options.completeFails === true
        ? Effect.fail(
            new ScopedRoutineInvocationError({
              code: 'scoped_routine_invocation_failed',
              constraint: Option.none(),
              ownerModuleKey: 'pricing.price-group-catalog',
              postgresCode: Option.none(),
              reason: 'Unable to invoke the tenant-scoped completion routine',
              routineKey: 'complete_price_group_containment_projection',
            }),
          )
        : Effect.succeed([{ payload: { _tag: 'completed', completion: completedIntent } }]);
    },
  };
  const tenantScope: OutboxWorkerTenantScopeService = {
    run: (_workerContext, observe) =>
      observe({
        completionPublisher: {
          publish: (_definition, input) =>
            Effect.sync(() => {
              if (
                options.publishedCompletionIds === undefined ||
                !options.publishedCompletionIds.has(input.completionId)
              ) {
                observed.completions.push(input);
                options.publishedCompletionIds?.add(input.completionId);
              }
              return { domainEventId: input.completionId, outcome: 'PUBLISHED' as const };
            }),
        },
        routineInvoker: invoker,
        tenantId,
      }),
  };
  const containment: ResourceContainmentRelationshipMutationService = {
    touch: (input) =>
      Effect.sync(() => {
        observed.touches.push(input);
      }).pipe(Effect.andThen(touch(input))),
  };
  return handleReconcilePriceGroupContainmentProjection(request, options.handlerContext ?? context).pipe(
    Effect.provideService(OutboxWorkerTenantScope, tenantScope),
    Effect.provideService(ResourceContainmentRelationshipMutation, containment),
  );
};

it.effect('applies one atomic tuple set before finalizing and publishing the terminal created fact', () =>
  Effect.gen(function* reconcileAndPublish() {
    const observed = observeWorkerEffects();
    yield* runHandler(() => Effect.void, observed);
    expect(observed.touches).toHaveLength(1);
    expect(observed.touches[0]?.relationships).toHaveLength(6);
    expect(observed.routineNames).toEqual([
      'read_price_group_containment_projection_intent',
      'complete_price_group_containment_projection',
    ]);
    expect(observed.completions).toHaveLength(1);
    expect(observed.completions[0]).toMatchObject({
      completionId: mutationId,
      payloadJson: definition,
      sourceActionInvocationId: actionInvocationId,
      subjectResourceId: priceGroupId,
    });
  }),
);

it.effect('rejects a cross-tenant delivery before any containment mutation', () =>
  Effect.gen(function* rejectCrossTenantDelivery() {
    const observed = observeWorkerEffects();
    const failure = yield* Effect.flip(
      runHandler(() => Effect.void, observed, {
        handlerContext: { ...context, tenantId: '77777777-7777-4777-8777-777777777777' },
      }),
    );
    expect(Schema.is(ReconcilePriceGroupContainmentProjectionRejected)(failure)).toBe(true);
    expect(observed.routineNames).toEqual(['read_price_group_containment_projection_intent']);
    expect(observed.touches).toHaveLength(0);
    expect(observed.completions).toHaveLength(0);
  }),
);

it.effect('replays APPLIED intent idempotently without duplicating the terminal completion', () =>
  Effect.gen(function* replayAppliedIntent() {
    const observed = observeWorkerEffects();
    const publishedCompletionIds = new Set<string>();
    const options = { loadedIntent: completedIntent, publishedCompletionIds };
    yield* runHandler(() => Effect.void, observed, options);
    yield* runHandler(() => Effect.void, observed, options);
    expect(observed.touches).toHaveLength(2);
    expect(observed.touches.every(({ relationships }) => relationships.length === 6)).toBe(true);
    expect(observed.completions).toHaveLength(1);
    expect([...publishedCompletionIds]).toEqual([mutationId]);
  }),
);

it.effect('keeps the durable retry path when owner finalization fails after the external write', () =>
  Effect.gen(function* retainRetryAfterFinalizationOutage() {
    const observed = observeWorkerEffects();
    const failure = yield* Effect.flip(runHandler(() => Effect.void, observed, { completeFails: true }));
    expect(Schema.is(PriceGroupContainmentProjectionPersistenceUnavailable)(failure)).toBe(true);
    expect(observed.touches).toHaveLength(1);
    expect(observed.routineNames).toEqual([
      'read_price_group_containment_projection_intent',
      'complete_price_group_containment_projection',
    ]);
    expect(observed.completions).toHaveLength(0);
  }),
);

it.effect('leaves the intent pending and publishes nothing when the external projection is uncertain', () =>
  Effect.gen(function* retainRecoveryAnchor() {
    const observed = observeWorkerEffects();
    const failure = yield* Effect.flip(
      runHandler(
        () => Effect.fail(new ResourceContainmentMutationUnavailable({ reason: 'ambiguous acknowledgement' })),
        observed,
      ),
    );
    expect(Schema.is(ResourceContainmentMutationUnavailable)(failure)).toBe(true);
    expect(observed.touches).toHaveLength(1);
    expect(observed.routineNames).toEqual(['read_price_group_containment_projection_intent']);
    expect(observed.completions).toHaveLength(0);
  }),
);
