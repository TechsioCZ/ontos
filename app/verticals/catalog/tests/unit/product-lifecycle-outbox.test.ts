import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProductSchema } from '../../shared/domain/product.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-lifecycle-changed-v1.ts';
import { handleRetireProduct, retireProductAction } from '../../src/actions/retire-product.action.ts';
import { handleUpdateProduct, updateProductAction } from '../../src/actions/update-product.action.ts';
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
    authContextRef: 'job:lifecycle-outbox:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'lifecycle-outbox-test',
};
const unexpected = () => Effect.die('Unexpected persistence call');
const context = <
  Events extends
    | typeof updateProductAction.descriptor.domainEvents
    | typeof retireProductAction.descriptor.domainEvents,
>(
  domainEvents: Events,
  services: Partial<CatalogPersistence>,
) => {
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
  const value: ActionHandlerContext<Events, CatalogPersistence> = {
    actionInvocationId: '55555555-5555-4555-8555-555555555555',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        expect(Object.keys(domainEvents)).toContain(event.eventType);
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

describe('Product lifecycle committed event and outbox', () => {
  it.effect('links one activation message to the committed transition and exact Product revision', () =>
    Effect.gen(function* activation() {
      const state = context(updateProductAction.descriptor.domainEvents, {
        update: () => Effect.succeed({ _tag: 'updated', changed: true, product: product('ACTIVE', 2) }),
      });
      yield* handleUpdateProduct(
        { expectedRevision: 1, productRef, reason: 'Ready', targetLifecycle: 'ACTIVE' },
        state.value,
      );
      expect(state.outbox).toHaveLength(1);
      const event = state.events.find(({ eventType }) => eventType === 'commerce.catalog.product-lifecycle-changed.v1');
      expect(event).toBeDefined();
      expect(state.outbox[0]?.event).toBe(event?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: { changeKind: 'ACTIVATED', lifecycle: 'ACTIVE', productRef, revision: 2, tenantId },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.product-lifecycle-changed.v1',
      });
    }),
  );

  it.effect('publishes neither lifecycle event nor outbox on an unchanged update or rejection', () =>
    Effect.gen(function* unchanged() {
      const noOp = context(updateProductAction.descriptor.domainEvents, {
        update: () => Effect.succeed({ _tag: 'updated', changed: false, product: product('ACTIVE', 2) }),
      });
      yield* handleUpdateProduct(
        { expectedRevision: 2, productRef, reason: 'No change', targetLifecycle: 'ACTIVE' },
        noOp.value,
      );
      expect(noOp.events).toHaveLength(0);
      expect(noOp.outbox).toHaveLength(0);

      const rejected = context(updateProductAction.descriptor.domainEvents, {
        update: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 3 }),
      });
      yield* handleUpdateProduct(
        { expectedRevision: 2, productRef, reason: 'Stale', targetLifecycle: 'ACTIVE' },
        rejected.value,
      ).pipe(Effect.flip);
      expect(rejected.events).toHaveLength(0);
      expect(rejected.outbox).toHaveLength(0);
    }),
  );

  it.effect('links retirement only after the successful owner transition', () =>
    Effect.gen(function* retirement() {
      const state = context(retireProductAction.descriptor.domainEvents, {
        retire: () => Effect.succeed({ _tag: 'retired', product: product('RETIRED', 3) }),
      });
      yield* handleRetireProduct({ expectedRevision: 2, productRef, reason: 'Retired' }, state.value);
      const event = state.events.find(({ eventType }) => eventType === 'commerce.catalog.product-lifecycle-changed.v1');
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(event?.reference);
      expect(state.outbox[0]?.message.payloadJson).toMatchObject({
        changeKind: 'RETIRED',
        lifecycle: 'RETIRED',
        productRef,
        revision: 3,
        tenantId,
      });
    }),
  );

  it('rejects a lifecycle payload whose tenant or state contradicts its Product', () => {
    const payload = { changeKind: 'ACTIVATED', lifecycle: 'ACTIVE', productRef, revision: 2, tenantId };
    expect(Schema.is(OutboxPayloadSchema)(payload)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...payload, tenantId: variantId })).toBe(false);
    expect(Schema.is(OutboxPayloadSchema)({ ...payload, lifecycle: 'DRAFT' })).toBe(false);
  });
});
