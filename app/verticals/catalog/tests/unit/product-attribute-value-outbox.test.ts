import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  RemoveProductAttributeValuesPayloadSchema,
  SetProductAttributeValuesPayloadSchema,
} from '../../shared/actions/attribute-value-mutations.ts';
import { OutboxPayloadSchema as SelectionSourceChangedEventSchema } from '../../shared/outbox/commerce-catalog-selection-source-changed-v1.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { handleRemoveProductAttributeValues } from '../../src/actions/remove-product-attribute-values.action.ts';
import { handleSetProductAttributeValues } from '../../src/actions/set-product-attribute-values.action.ts';
import type { AttributeValuesPersistence } from '../../src/persistence/attribute-values-persistence.ts';
import type { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const attributeDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const variantRef = (resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
});
const inheritedVariants = [
  variantRef('44444444-4444-4444-8444-444444444444'),
  variantRef('55555555-5555-4555-8555-555555555555'),
] as const;
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const valueSetId = '77777777-7777-4777-8777-777777777777';
const classification = {
  evidenceRefs: ['catalog-review-1'],
  kind: 'EVIDENCED_CORRECTION',
  reason: 'Correct the documented Product value',
} as const;
const base = {
  attributeDefinitionRef,
  classification,
  expectedRevision: 1,
  productRef,
  reason: 'Correct the documented Product value',
};
const setPayload = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
  ...base,
  values: [{ kind: 'TEXT', text: 'stainless steel' }],
});
const removePayload = Schema.decodeUnknownSync(RemoveProductAttributeValuesPayloadSchema)(base);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-attribute-outbox:run:1',
    authMethod: 'system',
    principalId: '88888888-8888-4888-8888-888888888888',
    tenantId,
  }),
  correlationId: 'product-attribute-outbox-test',
};

const unexpected = () => Effect.die('Unexpected persistence call');
const domainEvents = {
  'commerce.catalog.selection-source-changed.v1': SelectionSourceChangedEventSchema,
} as const;
type Services = AttributeValuesPersistence & {
  readonly assessOpenSelectionImpact: (ref: ProductRef) => Effect.Effect<void, CatalogOpenSelectionImpactUnavailable>;
};
const services = (partial: Partial<AttributeValuesPersistence>): Services => ({
  assessOpenSelectionImpact: () => Effect.void,
  removeProductValues: unexpected,
  removeVariantOverride: unexpected,
  setProductValues: unexpected,
  setVariantOverride: unexpected,
  ...partial,
});
const context = (persistence: Services) => {
  const events: { eventType: string; payloadJson: unknown; reference: object; subjectResourceId: string }[] = [];
  const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const value: ActionHandlerContext<typeof domainEvents, Services> = {
    actionInvocationId,
    addDomainEvent: (event) =>
      Effect.sync(() => {
        const reference = Object.create(null);
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
    services: persistence,
  };
  return { events, outbox, value };
};

describe('Product attribute value committed selection source event', () => {
  it.effect('publishes one linked source revision for each proven inheriting Variant', () =>
    Effect.gen(function* sourceRevised() {
      const state = context(
        services({
          setProductValues: () =>
            Effect.succeed({
              affectedVariantRefs: inheritedVariants,
              attributeValueSetId: valueSetId,
              revision: 2,
              state: 'SET',
            }),
        }),
      );
      const result = yield* handleSetProductAttributeValues(setPayload, state.value);
      expect(result).toEqual({ attributeValueSetId: valueSetId, revision: 2, state: 'SET' });
      expect(state.events).toHaveLength(2);
      expect(state.events.map(({ payloadJson }) => payloadJson)).toEqual(
        inheritedVariants.map((affectedVariantRef) => ({
          changeId: actionInvocationId,
          changeKind: 'SOURCE_REVISED',
          productRef,
          source: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: valueSetId,
              resourceType: 'commerce.catalog.attribute-value-set',
              tenantId,
            },
            revision: 2,
          },
          sourceKind: 'INHERITED_VALUE',
          tenantId,
          variantRef: affectedVariantRef,
        })),
      );
      expect(state.events.every(({ subjectResourceId }) => subjectResourceId === valueSetId)).toBe(true);
      expect(state.outbox).toHaveLength(2);
      expect(state.outbox.map(({ event }) => event)).toEqual(state.events.map(({ reference }) => reference));
      expect(
        state.outbox.every(
          ({ message }) =>
            message.producerModuleKey === 'commerce.catalog' &&
            message.topic === 'commerce.catalog.selection-source-changed.v1',
        ),
      ).toBe(true);
    }),
  );

  it.effect('publishes the exact affected Variant for a Product source removal', () =>
    Effect.gen(function* sourceRemoved() {
      const state = context(
        services({
          removeProductValues: () =>
            Effect.succeed({
              affectedVariantRefs: [inheritedVariants[1]],
              attributeValueSetId: valueSetId,
              revision: 3,
              state: 'REMOVED',
            }),
        }),
      );
      yield* handleRemoveProductAttributeValues(removePayload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]?.payloadJson).toMatchObject({
        changeKind: 'SOURCE_REVISED',
        productRef,
        source: { resourceRef: { resourceId: valueSetId }, revision: 3 },
        variantRef: inheritedVariants[1],
      });
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
    }),
  );

  it.effect('stays silent for an empty proven population and fails closed when proof is absent', () =>
    Effect.gen(function* silenceAndFailClosed() {
      const overridden = context(
        services({
          setProductValues: () =>
            Effect.succeed({ affectedVariantRefs: [], attributeValueSetId: valueSetId, revision: 2, state: 'SET' }),
        }),
      );
      yield* handleSetProductAttributeValues(setPayload, overridden.value);
      expect(overridden.events).toHaveLength(0);
      expect(overridden.outbox).toHaveLength(0);

      const unproven = context(
        services({
          removeProductValues: () => Effect.succeed({ attributeValueSetId: valueSetId, revision: 3, state: 'REMOVED' }),
        }),
      );
      const failure = yield* handleRemoveProductAttributeValues(removePayload, unproven.value).pipe(Effect.flip);
      expect(Schema.is(CatalogPersistenceUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'Catalog could not prove the affected Variant population' });
      expect(unproven.events).toHaveLength(0);
      expect(unproven.outbox).toHaveLength(0);
    }),
  );
});
