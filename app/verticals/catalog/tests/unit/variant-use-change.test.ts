import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AttributeDefinitionSchema } from '../../shared/domain/attribute-values.ts';
import type { AttributeDefinition, AttributeValue } from '../../shared/domain/attribute-values.ts';
import { ProductVariantSchema } from '../../shared/domain/product.ts';
import type { VariantAxis, VariantAxisCandidate } from '../../shared/domain/variant-axes.ts';
import type { VariantUseChangeOperation } from '../../shared/domain/variant-use-change.ts';
import {
  VariantSelectionRevalidationRequiredSchema,
  VariantUseChangeConflict,
  VariantUseChangeOperationSchema,
  decideVariantUseChange,
  revalidateVariantAxisChange,
  revalidateVariantReactivation,
} from '../../shared/domain/variant-use-change.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const colorDefinition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Color',
  levels: ['VARIANT'],
  meaning: 'Actual color',
  multiplicity: 'SINGLE',
  ref: {
    moduleId: 'commerce.catalog',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  },
  specialStates: ['UNKNOWN'],
  valueKind: 'CONTROLLED',
});
const lengthDefinition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  ...colorDefinition,
  label: 'Length',
  meaning: 'Actual length',
  ref: { ...colorDefinition.ref, resourceId: '44444444-4444-4444-8444-444444444444' },
});
const controlled = (resourceId: string): AttributeValue => ({
  kind: 'CONTROLLED',
  valueRef: {
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType: 'commerce.catalog.controlled-attribute-value',
    tenantId,
  },
});
const white = controlled('55555555-5555-4555-8555-555555555555');
const black = controlled('66666666-6666-4666-8666-666666666666');
const eighty = controlled('77777777-7777-4777-8777-777777777777');
const variant = (id: string) =>
  Schema.decodeUnknownSync(ProductVariantSchema)({
    lifecycle: 'ACTIVE',
    productRef,
    variantId: id,
    variantRef: { moduleId: 'commerce.catalog', resourceId: id, resourceType: 'commerce.catalog.variant', tenantId },
  });
const axis = (definition: AttributeDefinition): VariantAxis => ({
  attributeDefinitionRef: definition.ref,
  definitionRevision: 3,
});
const candidate = (
  id: string,
  ...pairs: readonly (readonly [AttributeDefinition, AttributeValue])[]
): VariantAxisCandidate => ({
  effectiveAxisValues: pairs.map(([definition, value]) => ({
    attributeDefinitionRef: definition.ref,
    values: [value],
  })),
  variant: variant(id),
});
const rules = [
  { attributeDefinitionRef: colorDefinition.ref, level: 'VARIANT', required: false },
  { attributeDefinitionRef: lengthDefinition.ref, level: 'VARIANT', required: false },
] as const;
const evidenceBase = { evidenceRefs: ['urn:evidence:record-1'], reason: 'Documented correction' } as const;
const decodeOperation = (operation: VariantUseChangeOperation) =>
  Schema.decodeUnknownSync(VariantUseChangeOperationSchema)(operation);
const conflictOf = (operation: VariantUseChangeOperation) =>
  decideVariantUseChange(decodeOperation(operation), { currentProductRef: productRef }).pipe(Effect.flip);
const revalidate = (candidates: readonly VariantAxisCandidate[], proposedAxes: readonly VariantAxis[]) =>
  revalidateVariantAxisChange({
    candidates,
    definitions: [
      { definition: colorDefinition, revision: 3 },
      { definition: lengthDefinition, revision: 3 },
    ],
    isAllowedValue: () => true,
    isRecordedCombination: () => true,
    productRef,
    productTypeRules: rules,
    proposedAxes,
  });

describe('Variant use change classification (#441)', () => {
  it.effect('accepts a decoded explicit operation and preserves identity for a same-meaning rename', () =>
    Effect.gen(function* sameMeaning() {
      const decision = yield* decideVariantUseChange(
        decodeOperation({ ...evidenceBase, kind: 'SAME_MEANING_RENAME' }),
        {
          currentProductRef: productRef,
        },
      );
      expect(decision).toEqual({ changeKind: 'CORRECTED', revalidation: 'NOT_REQUIRED' });
    }),
  );

  it.effect('preserves identity but requires revalidation for a documented value correction', () =>
    Effect.gen(function* evidencedCorrection() {
      const decision = yield* decideVariantUseChange(
        decodeOperation({
          ...evidenceBase,
          kind: 'EVIDENCED_VALUE_CORRECTION',
          originalDataErrorEvidenceRef: 'urn:evidence:record-1',
        }),
        { currentProductRef: productRef },
      );
      expect(decision).toEqual({ changeKind: 'CORRECTED', revalidation: 'REQUIRED' });
    }),
  );

  it.effect('requires the correction evidence to identify the original data error', () =>
    Effect.gen(function* missingOriginalError() {
      const failure = yield* conflictOf({
        ...evidenceBase,
        kind: 'EVIDENCED_VALUE_CORRECTION',
        originalDataErrorEvidenceRef: 'urn:evidence:not-present',
      });
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'CORRECTION_EVIDENCE_REQUIRED' });
    }),
  );

  it.effect('rejects a genuinely new atomic realization from the in-place change path', () =>
    Effect.gen(function* newRealization() {
      const failure = yield* conflictOf({ ...evidenceBase, kind: 'NEW_REALIZATION' });
      expect(failure).toMatchObject({ conflict: 'NEW_REALIZATION_REQUIRES_NEW_VARIANT' });
    }),
  );

  it.effect('allows an evidenced parent correction but rejects a real membership transfer', () =>
    Effect.gen(function* membership() {
      const targetProductRef = { ...productRef, resourceId: '88888888-8888-4888-8888-888888888888' };
      const corrected = yield* decideVariantUseChange(
        decodeOperation({ ...evidenceBase, kind: 'EVIDENCED_MEMBERSHIP_CORRECTION', targetProductRef }),
        { currentProductRef: productRef },
      );
      expect(corrected).toEqual({ changeKind: 'PARENT_CORRECTION', revalidation: 'REQUIRED' });

      const sameProduct = yield* conflictOf({
        ...evidenceBase,
        kind: 'EVIDENCED_MEMBERSHIP_CORRECTION',
        targetProductRef: productRef,
      });
      expect(sameProduct).toMatchObject({ conflict: 'MEMBERSHIP_CORRECTION_MUST_CHANGE_PRODUCT' });

      const crossTenant = yield* conflictOf({
        ...evidenceBase,
        kind: 'EVIDENCED_MEMBERSHIP_CORRECTION',
        targetProductRef: { ...targetProductRef, tenantId: otherTenantId },
      });
      expect(crossTenant).toMatchObject({ conflict: 'MEMBERSHIP_CORRECTION_MUST_CHANGE_PRODUCT' });

      const transfer = yield* conflictOf({
        ...evidenceBase,
        kind: 'MEMBERSHIP_TRANSFER',
        targetProductRef,
      });
      expect(transfer).toMatchObject({ conflict: 'MEMBERSHIP_TRANSFER_REQUIRES_NEW_VARIANT' });
    }),
  );

  it.effect('rejects an in-place reactivation that collides with a Current combination', () =>
    Effect.gen(function* reactivationCollision() {
      const key = 'a'.repeat(64);
      const collision = yield* revalidateVariantReactivation({
        activeCombinationKeys: [key],
        parentProductLifecycle: 'ACTIVE',
        reactivationCombinationKey: key,
        requiredPackageOptions: [],
      }).pipe(Effect.flip);
      expect(collision).toMatchObject({ conflict: 'DUPLICATE_COMBINATION' });

      const clean = yield* revalidateVariantReactivation({
        activeCombinationKeys: ['b'.repeat(64)],
        parentProductLifecycle: 'ACTIVE',
        reactivationCombinationKey: key,
        requiredPackageOptions: [],
      });
      expect(clean).toEqual({ changeKind: 'CORRECTED', revalidation: 'REQUIRED' });
    }),
  );

  it.effect('blocks reactivation under a retired parent Product before checking combinations', () =>
    Effect.gen(function* retiredParent() {
      const key = 'a'.repeat(64);
      const failure = yield* revalidateVariantReactivation({
        activeCombinationKeys: [],
        parentProductLifecycle: 'RETIRED',
        reactivationCombinationKey: key,
        requiredPackageOptions: [],
      }).pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'RETIRED_PARENT_PRODUCT' });
    }),
  );

  it.effect('blocks reactivation while a required Package Option is retired or inactive', () =>
    Effect.gen(function* retiredPackageOption() {
      const key = 'a'.repeat(64);
      const retired = yield* revalidateVariantReactivation({
        activeCombinationKeys: ['b'.repeat(64)],
        parentProductLifecycle: 'ACTIVE',
        reactivationCombinationKey: key,
        requiredPackageOptions: [{ lifecycle: 'ACTIVE' }, { lifecycle: 'RETIRED' }],
      }).pipe(Effect.flip);
      expect(retired).toMatchObject({ conflict: 'RETIRED_PACKAGE_OPTION' });

      const active = yield* revalidateVariantReactivation({
        activeCombinationKeys: ['b'.repeat(64)],
        parentProductLifecycle: 'ACTIVE',
        reactivationCombinationKey: key,
        requiredPackageOptions: [{ lifecycle: 'ACTIVE' }],
      });
      expect(active).toEqual({ changeKind: 'CORRECTED', revalidation: 'REQUIRED' });
    }),
  );
});

describe('Variant axis change revalidation (#438/#440/#441)', () => {
  it.effect('does not invent a value for a newly added axis', () =>
    Effect.gen(function* missingAddedAxis() {
      const failure = yield* revalidate(
        [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [colorDefinition, white])],
        [axis(colorDefinition), axis(lengthDefinition)],
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict: 'MISSING_AXIS_VALUE' });
    }),
  );

  it.effect('accepts an axis addition once every affected Variant carries a documented value', () =>
    Effect.gen(function* documentedAddedAxis() {
      const decision = yield* revalidate(
        [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [colorDefinition, white], [lengthDefinition, eighty])],
        [axis(colorDefinition), axis(lengthDefinition)],
      );
      expect(decision).toEqual({ changeKind: 'AXIS_REVALIDATION', revalidation: 'REQUIRED' });
    }),
  );

  it.effect('rejects an axis removal that would leave two indistinguishable Current Variants', () =>
    Effect.gen(function* removalDuplicate() {
      const failure = yield* revalidate(
        [
          candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [colorDefinition, white], [lengthDefinition, eighty]),
          candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [colorDefinition, black], [lengthDefinition, eighty]),
        ],
        [axis(lengthDefinition)],
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict: 'DUPLICATE_COMBINATION' });
    }),
  );

  it.effect('accepts an axis removal that keeps every Current Variant distinguishable', () =>
    Effect.gen(function* removalDistinct() {
      const decision = yield* revalidate(
        [
          candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [colorDefinition, white], [lengthDefinition, eighty]),
          candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [colorDefinition, black], [lengthDefinition, eighty]),
        ],
        [axis(colorDefinition)],
      );
      expect(decision).toEqual({ changeKind: 'AXIS_REVALIDATION', revalidation: 'REQUIRED' });
    }),
  );

  it.effect('fails closed when allowed values or recorded forms cannot be verified', () =>
    Effect.gen(function* unverifiable() {
      const unverifiableAllowed = new Map<string, boolean>([['present', true]]);
      const failure = yield* revalidateVariantAxisChange({
        candidates: [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [colorDefinition, white])],
        definitions: [
          { definition: colorDefinition, revision: 3 },
          { definition: lengthDefinition, revision: 3 },
        ],
        isAllowedValue: () => unverifiableAllowed.get('absent'),
        productRef,
        productTypeRules: rules,
        proposedAxes: [axis(colorDefinition), axis(lengthDefinition)],
      }).pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict: 'UNVERIFIABLE_VALUE' });
    }),
  );
});

describe('Variant selection revalidation handoff (#479)', () => {
  it('binds an affected Variant to the exact Product Tenant', () => {
    const decode = Schema.decodeUnknownSync(VariantSelectionRevalidationRequiredSchema);
    expect(
      decode({
        affectedVariantRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
        evidenceRefs: ['urn:evidence:record-1'],
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason: 'Corrected recorded value',
        revision: 2,
      }).affectedVariantRef.tenantId,
    ).toBe(tenantId);
    expect(() =>
      decode({
        affectedVariantRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.catalog.variant',
          tenantId: otherTenantId,
        },
        evidenceRefs: ['urn:evidence:record-1'],
        kind: 'REVALIDATION_REQUIRED',
        productRef,
        reason: 'Cross-tenant Variant',
        revision: 2,
      }),
    ).toThrow();
  });
});
