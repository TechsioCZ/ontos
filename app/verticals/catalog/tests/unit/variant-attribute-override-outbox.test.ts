import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  RemoveVariantAttributeOverridePayloadSchema,
  SetVariantAttributeOverridePayloadSchema,
} from '../../shared/actions/attribute-value-mutations.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import {
  handleRemoveVariantAttributeOverride,
  removeVariantAttributeOverrideAction,
} from '../../src/actions/remove-variant-attribute-override.action.ts';
import {
  handleSetVariantAttributeOverride,
  setVariantAttributeOverrideAction,
} from '../../src/actions/set-variant-attribute-override.action.ts';
import type { AttributeValuesPersistence } from '../../src/persistence/attribute-values-persistence.ts';
import { AttributeValuesConflict } from '../../src/persistence/attribute-values-persistence.ts';
import type { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';

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
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const actionInvocationId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-override-outbox:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'variant-override-outbox-test',
};

const setPayload = Schema.decodeUnknownSync(SetVariantAttributeOverridePayloadSchema)({
  attributeDefinitionRef,
  classification: { evidenceRefs: ['type-rule-review-1'], kind: 'NON_MATERIAL', reason: 'Restated value' },
  expectedRevision: null,
  productRef,
  reason: 'Set the exact Variant value',
  values: [{ kind: 'TEXT', text: '90 cm' }],
  variantRef,
});
const removePayload = Schema.decodeUnknownSync(RemoveVariantAttributeOverridePayloadSchema)({
  attributeDefinitionRef,
  classification: { evidenceRefs: ['type-rule-review-1'], kind: 'NON_MATERIAL', reason: 'Override no longer needed' },
  expectedProductValueRevision: 4,
  expectedRevision: 1,
  productRef,
  reason: 'Release the Variant override',
  variantRef,
});

const unexpected = () => Effect.die('Unexpected persistence call');
type VariantAttributeServices = AttributeValuesPersistence & {
  readonly assessOpenSelectionImpact: (ref: ProductRef) => Effect.Effect<void, CatalogOpenSelectionImpactUnavailable>;
};
const services = (partial: Partial<AttributeValuesPersistence>): VariantAttributeServices => ({
  assessOpenSelectionImpact: unexpected,
  removeProductValues: unexpected,
  removeVariantOverride: unexpected,
  setProductValues: unexpected,
  setVariantOverride: unexpected,
  ...partial,
});
const context = <DomainEvents extends DomainEventContractMap>(
  domainEvents: DomainEvents,
  persistence: VariantAttributeServices,
) => {
  const events: { eventType: string; payloadJson: unknown; reference: object }[] = [];
  const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const value: ActionHandlerContext<DomainEvents, VariantAttributeServices> = {
    actionInvocationId,
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

const staleConflict = new AttributeValuesConflict({
  code: 'attribute_values_conflict',
  conflict: 'BASIS_CHANGED',
  reason: 'Inherited Product value source changed',
});

describe('Variant attribute override committed selection source event', () => {
  it.effect('links one inherited-value event to the committed override set', () =>
    Effect.gen(function* setOverride() {
      const state = context(
        setVariantAttributeOverrideAction.descriptor.domainEvents,
        services({
          setVariantOverride: () =>
            Effect.succeed({
              attributeValueSetId: '77777777-7777-4777-8777-777777777777',
              revision: 1,
              state: 'SET',
            }),
        }),
      );
      const result = yield* handleSetVariantAttributeOverride(setPayload, state.value);
      expect(result).toMatchObject({ revision: 1, state: 'SET' });
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.selection-source-changed.v1',
        payloadJson: {
          changeId: actionInvocationId,
          changeKind: 'OVERRIDE_SET',
          productRef,
          source: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: '77777777-7777-4777-8777-777777777777',
              resourceType: 'commerce.catalog.attribute-value-set',
              tenantId,
            },
            revision: 1,
          },
          sourceKind: 'INHERITED_VALUE',
          tenantId,
          variantRef,
        },
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.selection-source-changed.v1',
      });
      expect(Object.keys(state.events[0]?.payloadJson ?? {})).not.toContain('currentAtCommit');
    }),
  );

  it.effect('links one inherited-value event to the committed override release', () =>
    Effect.gen(function* removeOverride() {
      const state = context(
        removeVariantAttributeOverrideAction.descriptor.domainEvents,
        services({
          removeVariantOverride: () =>
            Effect.succeed({
              attributeValueSetId: '77777777-7777-4777-8777-777777777777',
              revision: 2,
              state: 'REMOVED',
            }),
        }),
      );
      yield* handleRemoveVariantAttributeOverride(removePayload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.selection-source-changed.v1',
        payloadJson: {
          changeKind: 'OVERRIDE_RELEASED',
          source: { revision: 2 },
          sourceKind: 'INHERITED_VALUE',
          variantRef,
        },
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
    }),
  );

  it.effect('emits neither event nor outbox when the override write is rejected or stale', () =>
    Effect.gen(function* rejected() {
      const rejectedSet = context(
        setVariantAttributeOverrideAction.descriptor.domainEvents,
        services({
          setVariantOverride: () => Effect.fail(staleConflict),
        }),
      );
      yield* handleSetVariantAttributeOverride(setPayload, rejectedSet.value).pipe(Effect.flip);
      expect(rejectedSet.events).toHaveLength(0);
      expect(rejectedSet.outbox).toHaveLength(0);

      const rejectedRelease = context(
        removeVariantAttributeOverrideAction.descriptor.domainEvents,
        services({
          removeVariantOverride: () => Effect.fail(staleConflict),
        }),
      );
      yield* handleRemoveVariantAttributeOverride(removePayload, rejectedRelease.value).pipe(Effect.flip);
      expect(rejectedRelease.events).toHaveLength(0);
      expect(rejectedRelease.outbox).toHaveLength(0);
    }),
  );

  it.effect('emits nothing for a NEW_REALIZATION classification that cannot be an in-place override', () =>
    Effect.gen(function* newRealization() {
      const state = context(
        setVariantAttributeOverrideAction.descriptor.domainEvents,
        services({
          setVariantOverride: unexpected,
        }),
      );
      const payload = Schema.decodeUnknownSync(SetVariantAttributeOverridePayloadSchema)({
        ...setPayload,
        classification: {
          evidenceRefs: ['type-rule-review-1'],
          kind: 'NEW_REALIZATION',
          newVariantRef: variantRef,
          reason: 'Distinct atomic realization',
        },
      });
      yield* handleSetVariantAttributeOverride(payload, state.value).pipe(Effect.flip);
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }),
  );
});
