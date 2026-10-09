import { describe, expect, it } from 'effect-rstest';
import { Option, Schema } from 'effect';

import {
  resolveProductOnlyVariant,
  resolveVariantExactForm,
  VariantExactFormSchema,
} from '../../shared/domain/variant-exact-form.ts';
import { ProductVariantSchema } from '../../shared/domain/product.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

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
const decodeVariant = Schema.decodeUnknownSync(ProductVariantSchema);
const recordedVariant = decodeVariant({
  lifecycle: 'WORK_IN_PROGRESS',
  productRef,
  variantId: variantRef.resourceId,
  variantRef,
});

describe('Variant exact form foundation', () => {
  it('resolves only one Active Variant, never a draft or retired sole Variant', () => {
    const product = { productRef: recordedVariant.productRef, variants: [recordedVariant] };
    expect(resolveProductOnlyVariant(product)).toEqual({ status: 'NO_ELIGIBLE_VARIANT' });
    expect(resolveProductOnlyVariant({ ...product, variants: [{ ...recordedVariant, lifecycle: 'RETIRED' }] })).toEqual(
      {
        status: 'NO_ELIGIBLE_VARIANT',
      },
    );
    expect(resolveProductOnlyVariant({ ...product, variants: [{ ...recordedVariant, lifecycle: 'ACTIVE' }] })).toEqual({
      exactForm: { productRef, variantRef },
      status: 'RESOLVED',
    });
  });

  it('requires a more precise choice when a second Active Variant appears', () => {
    const anotherVariantRef = Schema.decodeUnknownSync(VariantRefSchema)({
      ...variantRef,
      resourceId: '44444444-4444-4444-8444-444444444444',
    });
    const first = { ...recordedVariant, lifecycle: 'ACTIVE' as const };
    const second = { ...first, variantId: anotherVariantRef.resourceId, variantRef: anotherVariantRef };
    expect(resolveProductOnlyVariant({ productRef: recordedVariant.productRef, variants: [first, second] })).toEqual({
      status: 'AMBIGUOUS',
    });
    expect(resolveProductOnlyVariant({ productRef: recordedVariant.productRef, variants: [second, first] })).toEqual({
      status: 'AMBIGUOUS',
    });
    expect(
      resolveVariantExactForm({ productRef: recordedVariant.productRef, variants: [first, second] }, variantRef),
    ).toEqual(Option.some({ productRef, variantRef }));
  });
  it('requires Product and Variant ResourceRefs from one Tenant', () => {
    const decode = Schema.decodeUnknownSync(VariantExactFormSchema, { onExcessProperty: 'error' });
    expect(decode({ productRef, variantRef })).toEqual({ productRef, variantRef });
    expect(() => decode({ productRef, variantRef: { ...variantRef, tenantId: otherTenantId } })).toThrow();
    expect(() => decode({ productRef, sku: 'NOT_AN_IDENTITY', variantRef })).toThrow();
  });

  it('resolves an explicit working Variant without asserting it is selectable', () => {
    const product = {
      productRef: Schema.decodeUnknownSync(VariantExactFormSchema)({ productRef, variantRef }).productRef,
      variants: [recordedVariant],
    };
    const resolved = resolveVariantExactForm(product, recordedVariant.variantRef);
    expect(Option.isSome(resolved)).toBe(true);
    if (Option.isSome(resolved)) {
      expect(resolved.value).toEqual({ productRef, variantRef });
    }
  });

  it('keeps a retired Variant exactly addressable for historical references', () => {
    const retiredVariant = decodeVariant({
      lifecycle: 'RETIRED',
      productRef,
      variantId: variantRef.resourceId,
      variantRef,
    });
    const resolved = resolveVariantExactForm(
      { productRef: retiredVariant.productRef, variants: [retiredVariant] },
      retiredVariant.variantRef,
    );
    expect(Option.isSome(resolved)).toBe(true);
    if (Option.isSome(resolved)) {
      expect(resolved.value).toEqual({ productRef, variantRef });
    }
  });

  it('does not invent a form or accept a Variant recorded under another Product', () => {
    const product = { productRef: recordedVariant.productRef, variants: [recordedVariant] };
    expect(
      Option.isNone(
        resolveVariantExactForm(product, {
          ...recordedVariant.variantRef,
          resourceId: Schema.decodeUnknownSync(VariantRefSchema)({
            ...variantRef,
            resourceId: '44444444-4444-4444-8444-444444444444',
          }).resourceId,
        }),
      ),
    ).toBe(true);
    const differentProduct = {
      ...recordedVariant.productRef,
      resourceId: Schema.decodeUnknownSync(ProductRefSchema)({
        ...productRef,
        resourceId: '55555555-5555-4555-8555-555555555555',
      }).resourceId,
    };
    expect(
      Option.isNone(
        resolveVariantExactForm(
          { productRef: differentProduct, variants: [recordedVariant] },
          recordedVariant.variantRef,
        ),
      ),
    ).toBe(true);
  });

  it('does not conflate two Products with identically described Variants', () => {
    const betaProductRef = Schema.decodeUnknownSync(ProductRefSchema)({
      ...productRef,
      resourceId: '55555555-5555-4555-8555-555555555555',
    });
    const betaVariantRef = Schema.decodeUnknownSync(VariantRefSchema)({
      ...variantRef,
      resourceId: '66666666-6666-4666-8666-666666666666',
    });
    const betaVariant = decodeVariant({
      lifecycle: 'WORK_IN_PROGRESS',
      productRef: betaProductRef,
      variantId: betaVariantRef.resourceId,
      variantRef: betaVariantRef,
    });
    expect(
      Option.isNone(resolveVariantExactForm({ productRef: betaProductRef, variants: [betaVariant] }, variantRef)),
    ).toBe(true);
    expect(
      Option.isSome(resolveVariantExactForm({ productRef: betaProductRef, variants: [betaVariant] }, betaVariantRef)),
    ).toBe(true);
  });

  it('rejects a wrong-tenant Variant reference even when its identifier matches', () => {
    const otherTenantVariantRef = Schema.decodeUnknownSync(VariantRefSchema)({
      ...variantRef,
      tenantId: otherTenantId,
    });
    expect(
      Option.isNone(
        resolveVariantExactForm(
          { productRef: recordedVariant.productRef, variants: [recordedVariant] },
          otherTenantVariantRef,
        ),
      ),
    ).toBe(true);
  });
});
