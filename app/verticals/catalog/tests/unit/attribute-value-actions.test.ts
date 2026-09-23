import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  RemoveProductAttributeValuesPayloadSchema,
  RemoveVariantAttributeOverridePayloadSchema,
  SetProductAttributeValuesPayloadSchema,
  SetVariantAttributeOverridePayloadSchema,
  VariantAttributeChangeClassificationSchema,
  VariantAttributeChangeConflict,
} from '../../shared/actions/attribute-value-mutations.ts';
import { OutboxPayloadSchema as SelectionSourceChangedEventSchema } from '../../shared/outbox/commerce-catalog-selection-source-changed-v1.ts';
import {
  handleRemoveProductAttributeValues,
  removeProductAttributeValuesAction,
} from '../../src/actions/remove-product-attribute-values.action.ts';
import {
  handleRemoveVariantAttributeOverride,
  removeVariantAttributeOverrideAction,
} from '../../src/actions/remove-variant-attribute-override.action.ts';
import {
  handleSetProductAttributeValues,
  setProductAttributeValuesAction,
} from '../../src/actions/set-product-attribute-values.action.ts';
import {
  handleSetVariantAttributeOverride,
  setVariantAttributeOverrideAction,
} from '../../src/actions/set-variant-attribute-override.action.ts';
import { AttributeValuesConflict } from '../../src/persistence/attribute-values-persistence.ts';
import type { AttributeValuesPersistence } from '../../src/persistence/attribute-values-persistence.ts';
import { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const attributeDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
};
const base = { attributeDefinitionRef, expectedRevision: null, productRef, reason: 'Assign documented product fact' };
const classification = {
  evidenceRefs: ['catalog-review-1'],
  kind: 'EVIDENCED_CORRECTION',
  reason: base.reason,
} as const;
const variantClassification = {
  evidenceRefs: ['catalog-review-1'],
  kind: 'NON_MATERIAL',
  reason: base.reason,
} as const;
const unexpected = () => Effect.die('Unexpected persistence method');
const unavailableImpact = () =>
  Effect.fail(
    new CatalogOpenSelectionImpactUnavailable({
      code: 'catalog_open_selection_impact_unavailable',
      reason: 'Population unavailable',
    }),
  );
const failure = (conflict: AttributeValuesConflict['conflict']) =>
  new AttributeValuesConflict({ code: 'attribute_values_conflict', conflict, reason: 'Unsafe value change' });
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:attribute-values:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'attribute-values-handoff-test',
};
const selectionSourceChangedDomainEvents = {
  'commerce.catalog.selection-source-changed.v1': SelectionSourceChangedEventSchema,
} as const;
const makeContext = <DomainEvents extends DomainEventContractMap = typeof selectionSourceChangedDomainEvents>(
  services: AttributeValuesPersistence,
  assessOpenSelectionImpact: (
    productRef: typeof base.productRef,
  ) => Effect.Effect<void, CatalogOpenSelectionImpactUnavailable> = () => Effect.void,
): ActionHandlerContext<
  DomainEvents,
  AttributeValuesPersistence & { assessOpenSelectionImpact: typeof assessOpenSelectionImpact }
> => ({
  actionInvocationId: '66666666-6666-4666-8666-666666666666',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services: { ...services, assessOpenSelectionImpact },
});

describe('Catalog attribute value Actions', () => {
  it('requires a real value and optimistic revision while distinguishing absent from unknown', () => {
    expect(Schema.is(SetProductAttributeValuesPayloadSchema)({ ...base, values: [] })).toBe(false);
    expect(Schema.is(SetProductAttributeValuesPayloadSchema)({ ...base, values: [{ kind: 'TEXT', text: '' }] })).toBe(
      false,
    );
    expect(
      Schema.is(SetProductAttributeValuesPayloadSchema)({
        ...base,
        classification,
        values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }],
      }),
    ).toBe(true);
    expect(
      Schema.is(SetProductAttributeValuesPayloadSchema)({
        ...base,
        expectedRevision: -1,
        values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }],
      }),
    ).toBe(false);
    expect(
      Schema.is(SetVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: variantClassification,
        values: [{ kind: 'TEXT', text: 'Blue' }],
        variantRef,
      }),
    ).toBe(true);
    expect(Schema.is(RemoveVariantAttributeOverridePayloadSchema)({ ...base, variantRef })).toBe(false);
    expect(
      Schema.is(RemoveVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: variantClassification,
        expectedProductValueRevision: null,
        variantRef,
      }),
    ).toBe(true);
  });

  it.effect('passes trusted execution identity and a typed value to scoped persistence', () =>
    Effect.gen(function* handoff() {
      const payload = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
        ...base,
        classification,
        values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }],
      });
      const services: AttributeValuesPersistence = {
        removeProductValues: unexpected,
        removeVariantOverride: unexpected,
        setProductValues: (input) =>
          Effect.sync(() => {
            expect(input.actionInvocationId).toBe('66666666-6666-4666-8666-666666666666');
            expect(input.principalId).toBe(scope.principalId);
            expect(input.values).toEqual([{ kind: 'SPECIAL', state: 'UNKNOWN' }]);
            return {
              affectedVariantRefs: [],
              attributeValueSetId: '77777777-7777-4777-8777-777777777777',
              revision: 1,
              state: 'SET' as const,
            };
          }),
        setVariantOverride: unexpected,
      };
      const result = yield* handleSetProductAttributeValues(payload, makeContext(services));
      expect(result.state).toBe('SET');
    }),
  );

  it.effect('does not write either Product attribute mutation when open-selection impact is unavailable', () =>
    Effect.gen(function* rejectedForUnavailableImpact() {
      const services: AttributeValuesPersistence = {
        removeProductValues: unexpected,
        removeVariantOverride: unexpected,
        setProductValues: unexpected,
        setVariantOverride: unexpected,
      };
      const context = makeContext(services, unavailableImpact);
      const set = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
        ...base,
        classification,
        values: [{ kind: 'TEXT', text: '90 cm' }],
      });
      const remove = Schema.decodeUnknownSync(RemoveProductAttributeValuesPayloadSchema)({ ...base, classification });
      const outcomes = yield* Effect.all([
        handleSetProductAttributeValues(set, context).pipe(Effect.flip),
        handleRemoveProductAttributeValues(remove, context).pipe(Effect.flip),
      ]);
      expect(outcomes.every(Schema.is(CatalogOpenSelectionImpactUnavailable))).toBe(true);
    }),
  );

  it.effect('removes a Variant override only with the caller-observed inherited source revision', () =>
    Effect.gen(function* removeOverrideHandoff() {
      const payload = Schema.decodeUnknownSync(RemoveVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: variantClassification,
        expectedProductValueRevision: 3,
        expectedRevision: 2,
        variantRef,
      });
      const services: AttributeValuesPersistence = {
        removeProductValues: unexpected,
        removeVariantOverride: (input) =>
          Effect.sync(() => {
            expect(input.expectedProductValueRevision).toBe(3);
            expect(input.expectedRevision).toBe(2);
            expect(input.variantRef.resourceId).toBe(variantRef.resourceId);
            expect(input.actionInvocationId).toBe('66666666-6666-4666-8666-666666666666');
            return {
              attributeValueSetId: '77777777-7777-4777-8777-777777777777',
              revision: 3,
              state: 'REMOVED' as const,
            };
          }),
        setProductValues: unexpected,
        setVariantOverride: unexpected,
      };
      const result = yield* handleRemoveVariantAttributeOverride(payload, makeContext(services));
      expect(result.state).toBe('REMOVED');
    }),
  );

  it.effect('rejects a new Variant realization and fails closed on correction without Current revalidation', () =>
    Effect.gen(function* classifyVariantChange() {
      const services: AttributeValuesPersistence = {
        removeProductValues: unexpected,
        removeVariantOverride: unexpected,
        setProductValues: unexpected,
        setVariantOverride: unexpected,
      };
      const newRealization = Schema.decodeUnknownSync(SetVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: {
          evidenceRefs: ['manufacturer-revision-2'],
          kind: 'NEW_REALIZATION',
          newVariantRef: { ...variantRef, resourceId: '88888888-8888-4888-8888-888888888888' },
          reason: 'Manufacturer changed the atomic form',
        },
        values: [{ kind: 'TEXT', text: '90 cm' }],
        variantRef,
      });
      const correction = Schema.decodeUnknownSync(RemoveVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: {
          evidenceRefs: ['original-measurement-error'],
          kind: 'EVIDENCED_CORRECTION',
          originalDataErrorEvidenceRef: 'original-measurement-error',
          reason: 'Original record measured the same form incorrectly',
        },
        expectedProductValueRevision: null,
        variantRef,
      });
      expect(
        yield* handleSetVariantAttributeOverride(newRealization, makeContext(services)).pipe(Effect.flip),
      ).toBeInstanceOf(VariantAttributeChangeConflict);
      expect(
        yield* handleRemoveVariantAttributeOverride(correction, makeContext(services, unavailableImpact)).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(CatalogOpenSelectionImpactUnavailable);
    }),
  );

  it('requires original-error evidence for a claimed Variant correction', () => {
    expect(
      Schema.is(VariantAttributeChangeClassificationSchema)({
        evidenceRefs: ['supplier-note'],
        kind: 'EVIDENCED_CORRECTION',
        reason: 'Original data was wrong',
      }),
    ).toBe(false);
  });

  it.effect('preserves typed fail-closed conflicts from all four persistence operations', () =>
    Effect.gen(function* rejectedChanges() {
      const services: AttributeValuesPersistence = {
        removeProductValues: () => Effect.fail(failure('REQUIRED')),
        removeVariantOverride: () => Effect.fail(failure('BASIS_CHANGED')),
        setProductValues: () => Effect.fail(failure('CONTROLLED_RETIRED')),
        setVariantOverride: () => Effect.fail(failure('IDENTITY_IMPACT')),
      };
      const context = makeContext(services);
      const variantContext = makeContext(services);
      const productSet = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
        ...base,
        classification,
        values: [{ kind: 'TEXT', text: 'Steel' }],
      });
      const productRemove = Schema.decodeUnknownSync(RemoveProductAttributeValuesPayloadSchema)({
        ...base,
        classification,
      });
      const variantSet = Schema.decodeUnknownSync(SetVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: variantClassification,
        values: [{ kind: 'TEXT', text: 'Blue' }],
        variantRef,
      });
      const variantRemove = Schema.decodeUnknownSync(RemoveVariantAttributeOverridePayloadSchema)({
        ...base,
        classification: variantClassification,
        expectedProductValueRevision: null,
        variantRef,
      });
      const outcomes = yield* Effect.all([
        handleSetProductAttributeValues(productSet, context).pipe(Effect.flip),
        handleRemoveProductAttributeValues(productRemove, context).pipe(Effect.flip),
        handleSetVariantAttributeOverride(variantSet, variantContext).pipe(Effect.flip),
        handleRemoveVariantAttributeOverride(variantRemove, variantContext).pipe(Effect.flip),
      ]);
      expect(
        outcomes.map((outcome) => (Schema.is(AttributeValuesConflict)(outcome) ? outcome.conflict : 'OTHER')),
      ).toEqual(['CONTROLLED_RETIRED', 'REQUIRED', 'IDENTITY_IMPACT', 'BASIS_CHANGED']);
    }),
  );

  it('requires explicit tenant permission, idempotency and typed conflict on each mutation', () => {
    const conflict = new AttributeValuesConflict({
      code: 'attribute_values_conflict',
      conflict: 'REVISION',
      reason: 'Revision changed',
    });
    for (const action of [
      setProductAttributeValuesAction,
      removeProductAttributeValuesAction,
      setVariantAttributeOverrideAction,
      removeVariantAttributeOverrideAction,
    ]) {
      expect(action.descriptor.entrypoint.scope).toBe('tenant');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(Schema.is(action.descriptor.domainErrorSchema)(conflict)).toBe(true);
    }
  });
});
