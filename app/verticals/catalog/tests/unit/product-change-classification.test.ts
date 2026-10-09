import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  ProductChangeClassificationSchema,
  classifyProductChange,
} from '../../shared/domain/product-change-classification.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const newVariantRef = { ...variantRef, resourceId: '44444444-4444-4444-8444-444444444444' };
const evidence = {
  affectsOpenSelection: true,
  evidenceRefs: ['catalog-review-123'],
  reason: 'Reviewed against the physical item',
};

describe('Catalog Product change classification', () => {
  it.effect('preserves Product and Variant identity for an evidence-backed cosmetic correction', () =>
    Effect.gen(function* cosmeticCorrection() {
      const change = Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        ...evidence,
        kind: 'COSMETIC_CORRECTION',
        productRef,
        variantRef,
      });
      const result = yield* classifyProductChange(change);
      if (result.kind !== 'NEW_PRODUCT') {
        expect(result.productRef).toEqual(productRef);
      }
      expect(result.kind).toBe('COSMETIC_CORRECTION');
      expect(result).toHaveProperty('variantRef', variantRef);
    }),
  );

  it.effect('models a new realization and material successor under the stable Product', () =>
    Effect.gen(function* materialRealization() {
      for (const change of [
        { ...evidence, kind: 'NEW_REALIZATION', newVariantRef, productRef },
        { ...evidence, kind: 'SUCCESSOR_REALIZATION', newVariantRef, previousVariantRef: variantRef, productRef },
      ]) {
        const decoded = Schema.decodeUnknownSync(ProductChangeClassificationSchema)(change);
        const result = yield* classifyProductChange(decoded);
        if (result.kind !== 'NEW_PRODUCT') {
          expect(result.productRef).toEqual(productRef);
        }
        expect(result).toHaveProperty('newVariantRef', newVariantRef);
      }
    }),
  );

  it('requires evidence and a reason for every classification', () => {
    expect(() =>
      Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        evidenceRefs: [],
        kind: 'COSMETIC_CORRECTION',
        productRef,
        reason: 'reviewed',
        variantRef,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        evidenceRefs: ['record-1'],
        kind: 'NEW_REALIZATION',
        newVariantRef,
        productRef,
        reason: ' ',
      }),
    ).toThrow();
  });

  it.effect('allows Product-only corrections and requires a distinct new Product identity', () =>
    Effect.gen(function* distinctProduct() {
      const correction = Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        ...evidence,
        kind: 'COSMETIC_CORRECTION',
        productRef,
      });
      expect((yield* classifyProductChange(correction)).kind).toBe('COSMETIC_CORRECTION');
      const replacement = Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        ...evidence,
        kind: 'NEW_PRODUCT',
        newProductRef: productRef,
        previousProductRef: productRef,
      });
      const conflict = yield* classifyProductChange(replacement).pipe(
        Effect.catchTag('ProductChangeClassificationConflict', (error) => Effect.succeed(error.code)),
      );
      expect(conflict).toBe('product_change_classification_conflict');
    }),
  );

  it.effect('rejects cross-Tenant references and reuse of a Variant for a material successor', () =>
    Effect.gen(function* invalidTransitions() {
      const crossTenant = Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        ...evidence,
        kind: 'NEW_REALIZATION',
        newVariantRef: { ...newVariantRef, tenantId: otherTenantId },
        productRef,
      });
      const reusedVariant = Schema.decodeUnknownSync(ProductChangeClassificationSchema)({
        ...evidence,
        kind: 'SUCCESSOR_REALIZATION',
        newVariantRef: variantRef,
        previousVariantRef: variantRef,
        productRef,
      });
      const first = yield* classifyProductChange(crossTenant).pipe(
        Effect.catchTag('ProductChangeClassificationConflict', (error) => Effect.succeed(error.code)),
      );
      const second = yield* classifyProductChange(reusedVariant).pipe(
        Effect.catchTag('ProductChangeClassificationConflict', (error) => Effect.succeed(error.code)),
      );
      expect(first).toBe('product_change_classification_conflict');
      expect(second).toBe('product_change_classification_conflict');
    }),
  );
});
