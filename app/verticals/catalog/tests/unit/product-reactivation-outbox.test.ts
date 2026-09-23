import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProductSchema } from '../../shared/domain/product.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-lifecycle-changed-v1.ts';
import { handleReactivateProduct, reactivateProductAction } from '../../src/actions/reactivate-product.action.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantId = '33333333-3333-4333-8333-333333333333';
const product = (lifecycle: 'DRAFT' | 'ACTIVE' | 'RETIRED', revision: number) =>
  Schema.decodeUnknownSync(ProductSchema)({
    catalogReady: lifecycle === 'ACTIVE',
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle,
    productRef,
    revision,
    updatedAt: '2026-09-17T10:01:00.000Z',
    variants: [
      {
        lifecycle: 'WORK_IN_PROGRESS',
        productRef,
        variantId,
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: variantId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
    ],
  });
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:reactivation-outbox:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'reactivation-outbox-test',
};
const unexpected = () => Effect.die('Unexpected persistence call');
const context = (services: Partial<CatalogPersistence>) => {
  const events: { eventType: string; payloadJson: unknown; reference: object }[] = [];
  const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const persistence: CatalogPersistence = {
    correct: unexpected,
    create: unexpected,
    getCreatedByInvocation: unexpected,
    getCurrent: unexpected,
    getHistory: unexpected,
    reactivate: unexpected,
    recoverCreateProduct: unexpected,
    recoverUpdateProduct: unexpected,
    retire: unexpected,
    update: unexpected,
    ...services,
  };
  const value: ActionHandlerContext<typeof reactivateProductAction.descriptor.domainEvents, CatalogPersistence> = {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        expect(Object.keys(reactivateProductAction.descriptor.domainEvents)).toContain(event.eventType);
        const reference = Object.create(null);
        events.push({ eventType: event.eventType, payloadJson: event.payloadJson, reference });
        return reference;
      }),
    addOutboxMessage: (event, message) =>
      Effect.sync(() => {
        outbox.push({ event, message });
      }),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: persistence,
  };
  return { events, outbox, value };
};

describe('Product reactivation committed event and outbox', () => {
  it.effect('links one activation lifecycle message to the committed reactivation', () =>
    Effect.gen(function* reactivation() {
      const state = context({
        reactivate: () => Effect.succeed({ _tag: 'reactivated', product: product('ACTIVE', 3) }),
      });
      yield* handleReactivateProduct({ expectedRevision: 2, productRef, reason: 'Reactivate Product' }, state.value);
      expect(state.events).toHaveLength(2);
      expect(state.events[0]?.eventType).toBe('commerce.catalog.product-reactivated.v1');
      const event = state.events.find(({ eventType }) => eventType === 'commerce.catalog.product-lifecycle-changed.v1');
      expect(event).toBeDefined();
      expect(event?.payloadJson).toMatchObject({
        changeKind: 'ACTIVATED',
        lifecycle: 'ACTIVE',
        productRef,
        revision: 3,
        tenantId,
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(event?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: {
          changeKind: 'ACTIVATED',
          lifecycle: 'ACTIVE',
          productRef,
          revision: 3,
          tenantId,
        },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.product-lifecycle-changed.v1',
      });
      expect(Object.keys(state.outbox[0]?.message.payloadJson ?? {})).not.toContain('currentAtCommit');
    }),
  );

  it.effect('emits neither event nor outbox for a rejected reactivation', () =>
    Effect.gen(function* rejected() {
      const stale = context({ reactivate: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 4 }) });
      yield* handleReactivateProduct({ expectedRevision: 2, productRef, reason: 'Stale' }, stale.value).pipe(
        Effect.flip,
      );
      expect(stale.events).toHaveLength(0);
      expect(stale.outbox).toHaveLength(0);

      const conflict = context({
        reactivate: () => Effect.succeed({ _tag: 'lifecycle_conflict', product: product('ACTIVE', 2) }),
      });
      yield* handleReactivateProduct({ expectedRevision: 2, productRef, reason: 'Not retired' }, conflict.value).pipe(
        Effect.flip,
      );
      expect(conflict.events).toHaveLength(0);
      expect(conflict.outbox).toHaveLength(0);
    }),
  );

  it('rejects a lifecycle payload whose tenant or state contradicts its Product', () => {
    const payload = { changeKind: 'ACTIVATED', lifecycle: 'ACTIVE', productRef, revision: 3, tenantId };
    expect(Schema.is(OutboxPayloadSchema)(payload)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...payload, tenantId: variantId })).toBe(false);
    expect(Schema.is(OutboxPayloadSchema)({ ...payload, lifecycle: 'DRAFT' })).toBe(false);
  });
});
