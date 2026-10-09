import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  ProductAttributeChangeClassificationSchema,
  RemoveProductAttributeValuesPayloadSchema,
  SetProductAttributeValuesPayloadSchema,
  requireProductAttributeCorrection,
} from '../../shared/actions/attribute-value-mutations.ts';

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
const corrected = {
  evidenceRefs: ['supplier-measurement-1'],
  kind: 'EVIDENCED_CORRECTION',
  reason: 'Record was wrong; item is unchanged',
};
const base = { attributeDefinitionRef, expectedRevision: 1, productRef, reason: 'Correct measured dimension' };

describe('Product attribute change classification', () => {
  it('requires a documented classification for set and removal', () => {
    expect(
      Schema.is(SetProductAttributeValuesPayloadSchema)({ ...base, values: [{ kind: 'TEXT', text: '90 cm' }] }),
    ).toBe(false);
    expect(Schema.is(RemoveProductAttributeValuesPayloadSchema)(base)).toBe(false);
    expect(
      Schema.is(SetProductAttributeValuesPayloadSchema)({
        ...base,
        classification: corrected,
        values: [{ kind: 'TEXT', text: '90 cm' }],
      }),
    ).toBe(true);
    expect(Schema.is(RemoveProductAttributeValuesPayloadSchema)({ ...base, classification: corrected })).toBe(true);
  });

  it('rejects missing evidence and cannot be made safe by a caller impact flag', () => {
    expect(Schema.is(ProductAttributeChangeClassificationSchema)({ ...corrected, evidenceRefs: [] })).toBe(false);
    expect(Schema.is(ProductAttributeChangeClassificationSchema)({ ...corrected, evidenceRefs: [' '] })).toBe(false);
    expect(Schema.is(ProductAttributeChangeClassificationSchema)({ ...corrected, reason: ' ' })).toBe(false);
  });

  it.effect('requires Current revalidation even for a stable Product identity', () =>
    Effect.gen(function* correction() {
      const classification = Schema.decodeUnknownSync(ProductAttributeChangeClassificationSchema)(corrected);
      expect(yield* requireProductAttributeCorrection(classification, productRef)).toEqual({
        kind: 'REVALIDATION_REQUIRED',
        productRef,
      });
    }),
  );

  it.effect('rejects a new realization from the in-place Product write path', () =>
    Effect.gen(function* realization() {
      const classification = Schema.decodeUnknownSync(ProductAttributeChangeClassificationSchema)({
        evidenceRefs: ['supplier-revision-2'],
        kind: 'NEW_REALIZATION',
        newVariantRef: { ...variantRef, resourceId: '55555555-5555-4555-8555-555555555555' },
        previousVariantRef: variantRef,
        reason: 'Manufacturer changed dimensions',
      });
      const result = yield* requireProductAttributeCorrection(classification, productRef).pipe(
        Effect.catchTag('ProductAttributeChangeConflict', (error) => Effect.succeed(error.code)),
      );
      expect(result).toBe('product_attribute_change_conflict');
    }),
  );
});
