import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ReviseSetCompositionPayloadSchema } from '../../shared/actions/revise-set-composition.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-set-composition-revised-v1.ts';
import type { reviseSetCompositionAction } from '../../src/actions/revise-set-composition.action.ts';
import { handleReviseSetComposition } from '../../src/actions/revise-set-composition.action.ts';
import type { SetCompositionPersistence } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const ref = (resourceType: string, resourceId: string, scopedTenantId = tenantId) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId: scopedTenantId,
});
const productRef = ref('product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('variant', '33333333-3333-4333-8333-333333333333');
const compositionRef = ref('set-composition', '44444444-4444-4444-8444-444444444444');
const revision = { resourceRef: compositionRef, revision: 2 };
const payload = Schema.decodeUnknownSync(ReviseSetCompositionPayloadSchema)({
  effectiveFrom: '2026-09-18T00:00:00.000Z',
  expectedRevision: 1,
  lifecycleState: 'ACTIVE',
  revision: {
    components: [
      {
        componentId: '77777777-7777-4777-8777-777777777777',
        quantity: { amount: '1', unitRef: ref('product-unit', '88888888-8888-4888-8888-888888888888') },
        selection: {
          productRef: ref('product', '99999999-9999-4999-8999-999999999999'),
          variantRef: ref('variant', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        },
      },
      {
        componentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        quantity: { amount: '2', unitRef: ref('product-unit', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') },
        selection: {
          productRef: ref('product', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
          variantRef: ref('variant', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
        },
      },
    ],
    predecessor: { resourceRef: compositionRef, revision: 1 },
    productRef,
    provenance: { changeKind: 'MATERIAL_CHANGE', evidenceRefs: ['catalog:verified'], reason: 'Changed set needs' },
    reference: revision,
    variantRef,
  },
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:set-event-test:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'set-composition-event-test',
};

const testContext = (publish: SetCompositionPersistence['publish']) => {
  const events: unknown[] = [];
  const messages: unknown[] = [];
  const context: ActionHandlerContext<
    typeof reviseSetCompositionAction.descriptor.domainEvents,
    SetCompositionPersistence & { captureResult: () => Effect.Effect<void> }
  > = {
    actionInvocationId,
    addDomainEvent: (event) =>
      Effect.sync(() => {
        events.push(event);
        return Object.create(null);
      }),
    addOutboxMessage: (_event, message) =>
      Effect.sync(() => {
        messages.push(message);
      }),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: {
      captureResult: () => Effect.void,
      publish,
      readCurrent: () => Effect.die('Unexpected readCurrent'),
      readRevision: () => Effect.die('Unexpected readRevision'),
    },
  };
  return { context, events, messages };
};

describe('Set composition revision event', () => {
  it.effect('publishes exact changed Set revision and one linked outbox message after a successful write', () =>
    Effect.gen(function* published() {
      const { context, events, messages } = testContext(() => Effect.succeed({ _tag: 'published', revision: 2 }));
      const result = yield* handleReviseSetComposition(payload, context);
      expect(result).toEqual({ revision: payload.revision.reference });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'commerce.catalog.set-composition-revised.v1',
        payloadJson: {
          changeId: actionInvocationId,
          changeKind: 'MATERIAL_CHANGE',
          productRef,
          revision,
          tenantId,
          variantRef,
        },
        producerModuleKey: 'commerce.catalog',
        subjectResourceId: compositionRef.resourceId,
        subjectResourceType: 'commerce.catalog.set-composition',
      });
      expect(messages).toEqual([
        {
          payloadJson: expect.objectContaining({ changeId: actionInvocationId, revision }),
          producerModuleKey: 'commerce.catalog',
          topic: 'commerce.catalog.set-composition-revised.v1',
        },
      ]);
    }),
  );

  it.effect('does not announce stale or invalid Set revisions', () =>
    Effect.gen(function* rejected() {
      for (const outcome of [
        { _tag: 'stale', actualRevision: 3 } as const,
        { _tag: 'invalid', reason: 'Component Current basis is invalid' } as const,
      ]) {
        const { context, events, messages } = testContext(() => Effect.succeed(outcome));
        yield* handleReviseSetComposition(payload, context).pipe(Effect.flip);
        expect(events).toHaveLength(0);
        expect(messages).toHaveLength(0);
      }
    }),
  );

  it('rejects cross-Tenant source identity in the published payload contract', () => {
    const valid = {
      changeId: actionInvocationId,
      changeKind: 'MATERIAL_CHANGE',
      effectiveFrom: payload.effectiveFrom,
      lifecycleState: payload.lifecycleState,
      productRef,
      revision,
      tenantId,
      variantRef,
    };
    expect(Schema.decodeUnknownSync(OutboxPayloadSchema)(valid)).toEqual(valid);
    expect(() => Schema.decodeUnknownSync(OutboxPayloadSchema)({ ...valid, tenantId: otherTenantId })).toThrow();
  });
});
