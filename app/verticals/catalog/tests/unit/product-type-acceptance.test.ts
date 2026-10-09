import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  canonicalizeProductTypeMeaning,
  ProductTypeMeaningClaimSchema,
  ProductTypeMeaningRejected,
  resolveCanonicalProductTypeMeaning,
  sameProductTypeMeaning,
} from '../../shared/domain/product-type-meaning.ts';
import { ProductTypeAssignmentConflict, selectCurrentProductType } from '../../shared/domain/product-type-identity.ts';
import { evaluateProductTypeRules, ProductTypeRulesRevisionSchema } from '../../shared/domain/product-type-rules.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { ProductTypeRefSchema } from '../../shared/resources/product-type.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const shelfTypeRef = Schema.decodeUnknownSync(ProductTypeRefSchema)({
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
});
const serviceTypeRef = Schema.decodeUnknownSync(ProductTypeRefSchema)({
  ...shelfTypeRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
});
const decodeProductRef = Schema.decodeUnknownSync(ProductRefSchema);
const shelfOne = decodeProductRef({
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const shelfTwo = decodeProductRef({ ...shelfOne, resourceId: '66666666-6666-4666-8666-666666666666' });
const serviceProduct = decodeProductRef({ ...shelfOne, resourceId: '77777777-7777-4777-8777-777777777777' });
const material = {
  moduleId: 'commerce.catalog',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const installationScope = { ...material, resourceId: '99999999-9999-4999-8999-999999999999' } as const;
const categoryRef = {
  ...material,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.catalog.product-category',
} as const;
const packageDefinitionRef = {
  ...material,
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.catalog.package-definition',
} as const;

const decodeRevision = Schema.decodeUnknownSync(ProductTypeRulesRevisionSchema);
const decodeClaim = Schema.decodeUnknownSync(ProductTypeMeaningClaimSchema);

describe('Product Type acceptance', () => {
  it.effect('shares one type and its rules across distinct Product identities', () =>
    Effect.gen(function* sharedType() {
      const rulesRevision = decodeRevision({
        productTypeRef: shelfTypeRef,
        revision: 1,
        rules: [{ attributeDefinitionRef: material, level: 'PRODUCT', required: true }],
      });
      const first = yield* selectCurrentProductType(shelfOne, [shelfTypeRef]);
      const second = yield* selectCurrentProductType(shelfTwo, [shelfTypeRef]);

      expect(first.currentProductTypeRef).toEqual(second.currentProductTypeRef);
      expect(first.productRef.resourceId).not.toBe(second.productRef.resourceId);
      expect(canonicalizeProductTypeMeaning(rulesRevision).rules).toHaveLength(1);
    }),
  );

  it.effect('rejects a second simultaneous Current Product Type instead of merging rules', () =>
    Effect.gen(function* secondType() {
      const error = yield* selectCurrentProductType(shelfOne, [shelfTypeRef, serviceTypeRef]).pipe(Effect.flip);
      expect(Schema.is(ProductTypeAssignmentConflict)(error)).toBe(true);
      expect(error.reason).toBe('MULTIPLE_CURRENT_TYPES');
    }),
  );

  it('leaves a Draft without a Type unresolved instead of presuming its minimum', () => {
    expect(evaluateProductTypeRules({ productRef: shelfOne, productValues: [], variants: [] })).toEqual({
      basisStatus: 'UNTYPED',
      minimumSatisfied: false,
      violations: [],
    });
  });

  it.effect('takes no meaning from a Category, price, Package Option, or sales channel', () =>
    Effect.gen(function* unrelatedFacts() {
      const meaning = canonicalizeProductTypeMeaning(
        decodeRevision({
          productTypeRef: shelfTypeRef,
          revision: 1,
          rules: [{ attributeDefinitionRef: material, level: 'PRODUCT', required: true }],
        }),
      );
      expect(Object.keys(meaning)).toEqual(['productTypeRef', 'revision', 'rules']);
      const claims = [
        decodeClaim({ categoryRef, kind: 'CATEGORY' }),
        decodeClaim({ kind: 'PACKAGE_OPTION', packageDefinitionRef }),
        decodeClaim({ channelName: 'web', kind: 'SALES_CHANNEL' }),
      ];
      for (const claim of claims) {
        const error = yield* resolveCanonicalProductTypeMeaning(claim).pipe(Effect.flip);
        expect(Schema.is(ProductTypeMeaningRejected)(error)).toBe(true);
      }
    }),
  );

  it.effect('distinguishes an Assembly service Type by required data, never by a menu label', () =>
    Effect.gen(function* serviceMeaning() {
      const shelfRules = decodeRevision({
        productTypeRef: shelfTypeRef,
        revision: 1,
        rules: [{ attributeDefinitionRef: material, level: 'PRODUCT', required: true }],
      });
      const serviceRules = decodeRevision({
        productTypeRef: serviceTypeRef,
        revision: 1,
        rules: [{ attributeDefinitionRef: installationScope, level: 'PRODUCT', required: true }],
      });
      expect(
        sameProductTypeMeaning(
          canonicalizeProductTypeMeaning(shelfRules),
          canonicalizeProductTypeMeaning(serviceRules),
        ),
      ).toBe(false);

      const serviceAssignment = yield* selectCurrentProductType(serviceProduct, [serviceTypeRef]);
      expect(serviceAssignment.currentProductTypeRef).toEqual(serviceRules.productTypeRef);
      const labelError = yield* resolveCanonicalProductTypeMeaning(
        decodeClaim({ kind: 'FREE_TEXT_LABEL', label: 'Assembly service' }),
      ).pipe(Effect.flip);
      expect(labelError.standIn).toBe('FREE_TEXT_LABEL');
    }),
  );
});
