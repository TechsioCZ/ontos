import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ProductSizeCurrentRequestSchema,
  ProductSizeCurrentResponseSchema,
} from '../../shared/apis/product-size-current.ts';
import { productSizeCurrentRead } from '../../src/api/product-size-current.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const sizeId = '33333333-3333-4333-8333-333333333333';
const measurement = {
  amount: 42,
  attributeDefinitionId: '55555555-5555-4555-8555-555555555555',
  attributeDefinitionRevision: 3,
  attributeValueSetId: '66666666-6666-4666-8666-666666666666',
  attributeValueSetRevision: 2,
  canonicalUnit: 'cm',
  meaning: 'Product chest width',
  quantity: 'length',
  unit: 'cm',
};

describe('Product Size Current governed read', () => {
  it('requires a Product target and resource read authorization', () => {
    expect(Schema.is(ProductSizeCurrentRequestSchema)({ productRef })).toBe(true);
    expect(
      Schema.is(ProductSizeCurrentRequestSchema)({
        productRef: { ...productRef, resourceType: 'commerce.catalog.variant' },
      }),
    ).toBe(false);
    expect(productSizeCurrentRead.descriptor.resourcePermission).toBeDefined();
    expect(productSizeCurrentRead.descriptor.permissionTarget).toBe('module');
    expect(productSizeCurrentRead.descriptor.legalEntityScope).toBe('required');
  });

  it('exposes only exact ordered Size identities and usage revision, without inferred dimensions', () => {
    expect(
      Schema.is(ProductSizeCurrentResponseSchema)({
        measurements: { status: 'ABSENT' },
        productRef,
        revision: 2,
        sizes: [
          { position: 0, sizeId },
          { position: 1, sizeId: '44444444-4444-4444-8444-444444444444' },
        ],
      }),
    ).toBe(true);
    expect(
      Schema.is(ProductSizeCurrentResponseSchema)({
        measurements: { status: 'ABSENT' },
        productRef,
        revision: 0,
        sizes: [],
      }),
    ).toBe(true);
    expect(
      Schema.is(ProductSizeCurrentResponseSchema)({
        measurements: { status: 'ABSENT' },
        productRef,
        revision: -1,
        sizes: [],
      }),
    ).toBe(false);
    expect(
      Schema.is(ProductSizeCurrentResponseSchema)({
        measurements: { status: 'ABSENT' },
        productRef,
        revision: 1,
        sizes: [{ position: 0, sizeId: '80' }],
      }),
    ).toBe(false);
  });

  it('keeps shared Size identity and ordering separate from each Product’s confirmed dimensions', () => {
    const otherProductRef = { ...productRef, resourceId: '77777777-7777-4777-8777-777777777777' };
    const productA = {
      measurements: { measurements: [measurement], status: 'KNOWN' },
      productRef,
      revision: 1,
      sizes: [{ position: 0, sizeId }],
    };
    const productB = {
      measurements: { measurements: [{ ...measurement, amount: 44 }], status: 'KNOWN' },
      productRef: otherProductRef,
      revision: 4,
      sizes: [{ position: 0, sizeId }],
    };
    expect(Schema.is(ProductSizeCurrentResponseSchema)(productA)).toBe(true);
    expect(Schema.is(ProductSizeCurrentResponseSchema)(productB)).toBe(true);
    expect(productA.sizes[0]?.sizeId).toBe(productB.sizes[0]?.sizeId);
    expect(productA.measurements.measurements[0]?.amount).not.toBe(productB.measurements.measurements[0]?.amount);
  });

  it('preserves unavailable evidence instead of inferring a numeric Size dimension', () => {
    const base = { productRef, revision: 1, sizes: [{ position: 0, sizeId }] };
    expect(Schema.is(ProductSizeCurrentResponseSchema)({ ...base, measurements: { status: 'UNAVAILABLE' } })).toBe(
      true,
    );
    expect(Schema.is(ProductSizeCurrentResponseSchema)({ ...base, measurements: { status: 'ABSENT' } })).toBe(true);
    expect(Schema.is(ProductSizeCurrentResponseSchema)({ ...base })).toBe(false);
    expect(
      Schema.is(ProductSizeCurrentResponseSchema)({
        ...base,
        measurements: { measurements: [{ ...measurement, attributeDefinitionRevision: 0 }], status: 'KNOWN' },
      }),
    ).toBe(false);
  });
});
