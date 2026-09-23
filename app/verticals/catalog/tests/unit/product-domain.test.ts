import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogReadinessSchema,
  ProductHistorySchema,
  ProductSchema,
  ProductVariantSchema,
  catalogReadiness,
} from '../../shared/domain/product.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const actionInvocationId = '44444444-4444-4444-8444-444444444444';
const instant = '2026-09-16T12:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;

describe('Catalog Product domain', () => {
  it('keeps one Product identity while allowing Catalog readiness to be derived', () => {
    const draft = {
      lifecycle: 'DRAFT',
      variants: [{ lifecycle: 'WORK_IN_PROGRESS', productRef, variantId, variantRef }],
    } as const;
    const active = {
      lifecycle: 'ACTIVE',
      variants: [{ lifecycle: 'ACTIVE', productRef, variantId, variantRef }],
    } as const;

    expect(catalogReadiness(draft, [])).toEqual({
      catalogReady: false,
      reasons: [
        'Product must be ACTIVE',
        'Product needs a current localized Catalog name',
        'Product needs at least one ACTIVE Variant',
        'Current Product Type, required facts, Variant axes, Unit and dependent content are not verified',
      ],
    });
    expect(catalogReadiness(active, ['  Standard Product  '])).toEqual({
      catalogReady: false,
      reasons: ['Current Product Type, required facts, Variant axes, Unit and dependent content are not verified'],
    });
    expect(catalogReadiness(active, [])).toEqual({
      catalogReady: false,
      reasons: [
        'Product needs a current localized Catalog name',
        'Current Product Type, required facts, Variant axes, Unit and dependent content are not verified',
      ],
    });
    expect(catalogReadiness(active, ['Police Alfa'])).toEqual({
      catalogReady: false,
      reasons: ['Current Product Type, required facts, Variant axes, Unit and dependent content are not verified'],
    });
    expect(Schema.decodeUnknownSync(ProductRefSchema)(productRef)).toEqual(productRef);
    expect(productRef.resourceId).toBe(productId);
  });

  it('requires an ACTIVE Variant rather than a work-in-progress or retired Variant', () => {
    const readiness = catalogReadiness(
      {
        lifecycle: 'ACTIVE',
        variants: [{ lifecycle: 'RETIRED', productRef, variantId, variantRef }],
      },
      ['Standard Product'],
    );

    expect(readiness).toEqual({
      catalogReady: false,
      reasons: [
        'Product needs at least one ACTIVE Variant',
        'Current Product Type, required facts, Variant axes, Unit and dependent content are not verified',
      ],
    });
    expect(
      catalogReadiness(
        {
          lifecycle: 'ACTIVE',
          variants: [{ lifecycle: 'WORK_IN_PROGRESS', productRef, variantId, variantRef }],
        },
        ['Standard Product'],
      ),
    ).toEqual({
      catalogReady: false,
      reasons: [
        'Product needs at least one ACTIVE Variant',
        'Current Product Type, required facts, Variant axes, Unit and dependent content are not verified',
      ],
    });
    expect(() => Schema.decodeUnknownSync(ProductVariantSchema)({ lifecycle: 'INVALID', variantId })).toThrow();
  });

  it('decodes immutable historical revisions and lifecycle evidence through the public schemas', () => {
    const product = Schema.decodeUnknownSync(ProductSchema)({
      catalogReady: true,
      createdAt: instant,
      lifecycle: 'ACTIVE',
      name: 'Standard Product',
      productRef,
      revision: 1,
      updatedAt: instant,
      variants: [{ lifecycle: 'ACTIVE', productRef, variantId, variantRef }],
    });
    const history = Schema.decodeUnknownSync(ProductHistorySchema)({
      historical: true,
      lifecycle: [
        {
          actionInvocationId,
          effectiveAt: instant,
          event: 'ACTIVATED',
          productRef,
          reason: 'Approved for Catalog use',
          recordedAt: instant,
        },
      ],
      productRef,
      revisions: [
        {
          actionInvocationId,
          changeKind: 'CREATED',
          evidenceRefs: [],
          lifecycle: 'ACTIVE',
          name: 'Standard Product',
          productRef,
          reason: 'Create the Product identity',
          recordedAt: instant,
          revision: 1,
          revisionReference: { resourceRef: productRef, revision: 1, revisionId: actionInvocationId },
        },
      ],
    });

    expect(product.productRef).toEqual(productRef);
    expect(history.revisions[0]?.productRef).toEqual(productRef);
    expect(Schema.decodeUnknownSync(CatalogReadinessSchema)(catalogReadiness(product, ['Standard Product']))).toEqual({
      catalogReady: false,
      reasons: ['Current Product Type, required facts, Variant axes, Unit and dependent content are not verified'],
    });
  });

  it('rejects missing or cross-owned Variants in the public Product aggregate', () => {
    const base = {
      catalogReady: false,
      createdAt: instant,
      lifecycle: 'DRAFT',
      name: 'Product',
      productRef,
      revision: 1,
      updatedAt: instant,
    } as const;
    const decode = Schema.decodeUnknownSync(ProductSchema);
    expect(() => decode({ ...base, variants: [] })).toThrow();
    expect(() =>
      decode({
        ...base,
        variants: [
          {
            lifecycle: 'WORK_IN_PROGRESS',
            productRef,
            variantId,
            variantRef: { ...variantRef, tenantId: '99999999-9999-4999-8999-999999999999' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...base,
        variants: [
          {
            lifecycle: 'WORK_IN_PROGRESS',
            productRef,
            variantId,
            variantRef: { ...variantRef, resourceId: '99999999-9999-4999-8999-999999999999' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...base,
        variants: [
          {
            lifecycle: 'WORK_IN_PROGRESS',
            productRef: { ...productRef, resourceId: '99999999-9999-4999-8999-999999999999' },
            variantId,
            variantRef,
          },
        ],
      }),
    ).toThrow();
  });
});
