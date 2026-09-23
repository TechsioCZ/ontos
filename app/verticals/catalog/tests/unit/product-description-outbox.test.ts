import type { ActionHandlerContext, DomainEventReference, OutboxMessage } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-description-changed-v1.ts';
import type { setProductLocalizedFactsAction } from '../../src/actions/set-product-localized-facts.action.ts';
import { handleSetProductLocalizedFacts } from '../../src/actions/set-product-localized-facts.action.ts';
import { LocalizedFactsPersistenceUnavailable } from '../../src/persistence/localized-product-facts-persistence.ts';
import type { localizedProductFactsPersistenceForScope } from '../../src/persistence/localized-product-facts-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-description-outbox:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'product-description-outbox-test',
};
const payload = {
  evidenceRefs: [],
  expectedRevision: 1,
  facts: { name: 'Trail bicycle' },
  locale: 'en',
  productRef,
  reason: 'Correct the public product name',
} as const;

type Services = ReturnType<typeof localizedProductFactsPersistenceForScope>;
type ChangeProduct = Services['changeProduct'];

const unexpected = () => Effect.die('Unexpected Localized Product facts operation');

const context = (changeProduct: ChangeProduct) => {
  const events: {
    eventType: string;
    payloadJson: unknown;
    reference: DomainEventReference;
    subjectResourceId: string;
  }[] = [];
  const outbox: { event: DomainEventReference; message: OutboxMessage }[] = [];
  // SAFETY: Test double for the opaque, identity-only Domain Event reference; the fake collector never
  // exposes it outside this context, so a fresh null-prototype token preserves the linked-message invariant.
  const services: Services = {
    changeProduct,
    changeVariant: unexpected,
    readProduct: unexpected,
    readVariant: unexpected,
  };
  const value: ActionHandlerContext<typeof setProductLocalizedFactsAction.descriptor.domainEvents, Services> = {
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        const reference: DomainEventReference = Object.create(null);
        events.push({
          eventType: event.eventType,
          payloadJson: event.payloadJson,
          reference,
          subjectResourceId: event.subjectResourceId,
        });
        return reference;
      }),
    addOutboxMessage: (event, message) =>
      Effect.sync(() => {
        outbox.push({ event, message });
      }),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
  return { events, outbox, value };
};

describe('committed localized Product description event', () => {
  it.effect('links one narrow Product-source event and outbox message to a committed locale revision', () =>
    Effect.gen(function* changed() {
      const state = context(() => Effect.succeed({ kind: 'CHANGED', revision: 2 }));
      yield* handleSetProductLocalizedFacts(payload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.product-description-changed.v1',
        payloadJson: { locale: 'en', productRef, revision: 2, tenantId },
        subjectResourceId: productRef.resourceId,
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: { locale: 'en', productRef, revision: 2, tenantId },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.product-description-changed.v1',
      });
    }),
  );

  it.effect('emits nothing for replay or rejected persistence', () =>
    Effect.gen(function* unchanged() {
      const replay = context(() => Effect.succeed({ kind: 'REPLAYED', revision: 2 }));
      yield* handleSetProductLocalizedFacts(payload, replay.value);
      expect(replay.events).toHaveLength(0);
      expect(replay.outbox).toHaveLength(0);

      const rejected = context(() =>
        Effect.fail(
          new LocalizedFactsPersistenceUnavailable({
            code: 'localized_facts_persistence_unavailable',
            reason: 'Unavailable',
          }),
        ),
      );
      yield* handleSetProductLocalizedFacts(payload, rejected.value).pipe(Effect.flip);
      expect(rejected.events).toHaveLength(0);
      expect(rejected.outbox).toHaveLength(0);
    }),
  );

  it('rejects cross-Tenant Product event payloads', () => {
    const valid = { locale: 'en', productRef, revision: 2, tenantId };
    expect(Schema.is(OutboxPayloadSchema)(valid)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, tenantId: '55555555-5555-4555-8555-555555555555' })).toBe(false);
  });
});
