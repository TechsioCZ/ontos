import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PublishProductConfigurationPayloadSchema } from '../../shared/actions/publish-product-configuration.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-configuration-published-v1.ts';
import { handlePublishProductConfiguration } from '../../src/actions/publish-product-configuration.action.ts';
import type { publishProductConfigurationAction } from '../../src/actions/publish-product-configuration.action.ts';
import type { ProductConfigurationPersistence } from '../../src/persistence/product-configuration-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const payload = Schema.decodeUnknownSync(PublishProductConfigurationPayloadSchema)({
  choices: [],
  compatibilityRules: [],
  definitionId: 'stable-config-definition',
  effectiveFrom: new Date('2026-09-18T10:00:00.000Z'),
  evidenceRefs: [],
  expectedRevision: 1,
  measuredRules: [],
  optionAllowances: [],
  productId: 'stable-product',
  reason: 'Published choice update',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:configuration-publication:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'configuration-publication-test',
};

const makeContext = (outcome: ReturnType<ProductConfigurationPersistence['publish']>) => {
  const events: { eventType: string; payloadJson: unknown; reference: object; subjectResourceId: string }[] = [];
  const messages: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const context: ActionHandlerContext<
    typeof publishProductConfigurationAction.descriptor.domainEvents,
    ProductConfigurationPersistence
  > = {
    actionInvocationId: '33333333-3333-4333-8333-333333333333',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        const reference = Object.create(null);
        events.push({ ...event, reference });
        return reference;
      }),
    addOutboxMessage: (event, message) =>
      Effect.sync(() => {
        messages.push({ event, message });
      }),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: {
      publish: () => outcome,
      readCurrent: () => Effect.succeedNone,
    } satisfies ProductConfigurationPersistence,
  };
  return { context, events, messages };
};

describe('Product Configuration publication event', () => {
  it.effect('records one typed event and linked outbox message after successful owner publication', () =>
    Effect.gen(function* publication() {
      const state = makeContext(Effect.succeed({ _tag: 'published', revision: 2 }));
      const result = yield* handlePublishProductConfiguration(payload, state.context);
      expect(result).toEqual({ definitionId: payload.definitionId, revision: 2 });
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.product-configuration-published.v1',
        subjectResourceId: payload.definitionId,
      });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]?.event).toBe(state.events[0]?.reference);
      expect(state.messages[0]?.message).toMatchObject({
        payloadJson: {
          definitionRef: {
            moduleId: 'commerce.catalog',
            resourceId: payload.definitionId,
            resourceType: 'commerce.catalog.configuration-definition',
            tenantId,
          },
          productRef: { resourceId: payload.productId, tenantId },
          revision: 2,
          tenantId,
        },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.product-configuration-published.v1',
      });
      expect(Schema.is(OutboxPayloadSchema)(state.messages[0]?.message.payloadJson)).toBe(true);
    }),
  );

  it.effect('does not announce a rejected publication', () =>
    Effect.gen(function* rejected() {
      const state = makeContext(
        Effect.succeed({ _tag: 'incompatible', reason: 'Open selections cannot be preserved' }),
      );
      yield* handlePublishProductConfiguration(payload, state.context).pipe(Effect.flip);
      expect(state.events).toHaveLength(0);
      expect(state.messages).toHaveLength(0);
    }),
  );

  it('rejects cross-Tenant or invalid revision event payloads', () => {
    const eventPayload = {
      definitionRef: {
        moduleId: 'commerce.catalog',
        resourceId: payload.definitionId,
        resourceType: 'commerce.catalog.configuration-definition',
        tenantId,
      },
      productRef: {
        moduleId: 'commerce.catalog',
        resourceId: payload.productId,
        resourceType: 'commerce.catalog.product',
        tenantId,
      },
      revision: 2,
      tenantId,
    };
    expect(Schema.is(OutboxPayloadSchema)(eventPayload)).toBe(true);
    expect(
      Schema.is(OutboxPayloadSchema)({
        ...eventPayload,
        definitionRef: {
          ...eventPayload.definitionRef,
          resourceType: 'commerce.catalog.product-configuration-definition',
        },
      }),
    ).toBe(false);
    expect(Schema.is(OutboxPayloadSchema)({ ...eventPayload, revision: 0 })).toBe(false);
    expect(
      Schema.is(OutboxPayloadSchema)({
        ...eventPayload,
        productRef: { ...eventPayload.productRef, tenantId: '44444444-4444-4444-8444-444444444444' },
      }),
    ).toBe(false);
  });
});
