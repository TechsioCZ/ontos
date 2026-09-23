import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { AttributeDefinitionSchema } from '../../shared/domain/attribute-values.ts';
import { resolveEffectiveAttributeValues } from '../../shared/domain/effective-attribute-values.ts';
import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
} from '../../shared/domain/product-type-rules.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { ProductTypeRefSchema } from '../../shared/resources/product-type.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = Schema.decodeUnknownSync(ProductRefSchema)(
  ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222'),
);
const variantRef = Schema.decodeUnknownSync(VariantRefSchema)(
  ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333'),
);
const siblingVariantRef = Schema.decodeUnknownSync(VariantRefSchema)(
  ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333334'),
);
const productTypeRef = Schema.decodeUnknownSync(ProductTypeRefSchema)(
  ref('commerce.catalog.product-type', '44444444-4444-4444-8444-444444444444'),
);
const definition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Material',
  levels: ['PRODUCT', 'VARIANT'],
  meaning: 'Material of the product',
  multiplicity: 'MULTIPLE',
  ref: ref('commerce.catalog.attribute-definition', '55555555-5555-4555-8555-555555555555'),
  specialStates: ['UNKNOWN', 'NOT_APPLICABLE'],
  valueKind: 'TEXT',
});
const measuredDefinition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Length',
  levels: ['PRODUCT', 'VARIANT'],
  meaning: 'Length of the product',
  measurement: { canonicalUnit: 'mm', decimalPlaces: 1, quantity: 'length' },
  multiplicity: 'SINGLE',
  ref: ref('commerce.catalog.attribute-definition', '55555555-5555-4555-8555-555555555555'),
  specialStates: [],
  valueKind: 'MEASUREMENT',
});
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rulesRevision = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
  effectiveFrom,
  productTypeRef,
  revision: 2,
  revisionId,
  rules: [
    { attributeDefinitionRef: definition.ref, level: 'PRODUCT', required: false },
    { attributeDefinitionRef: definition.ref, level: 'VARIANT', required: false },
  ],
});
const basis = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
  effectiveFrom,
  productTypeRef,
  revision: 2,
  revisionId,
  rules: rulesRevision.rules,
});
const currentBasis = Schema.decodeUnknownSync(ProductTypeCurrentBasisSchema)({
  currentRevision: 2,
  effectiveFrom,
  evaluatedAt: '2026-09-17T00:00:00.000Z',
  productTypeRef,
  revision: 2,
  revisionId,
});
const text = (value: string) => ({ kind: 'TEXT' as const, text: value });
const productSet = { revision: 3, state: 'SET' as const, values: [text('Steel')] };
const input = {
  basis: currentBasis,
  definition,
  productRef,
  productSet,
  rulesRevision: basis,
  variantProductRef: productRef,
  variantRef,
  variantSet: null,
};

describe('effective Product/Variant attribute values', () => {
  it('inherits live Product values with provenance and follows a later Product revision', () => {
    expect(resolveEffectiveAttributeValues(input)).toMatchObject({
      productRevision: 3,
      source: { level: 'PRODUCT', revision: 3 },
      status: 'CURRENT',
      values: [text('Steel')],
    });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        productSet: { ...productSet, revision: 4, values: [text('Stainless')] },
      }),
    ).toMatchObject({ source: { revision: 4 }, status: 'CURRENT', values: [text('Stainless')] });
  });

  it('uses the entire explicit multiple override and does not merge Product values', () => {
    const variantSet = { revision: 6, state: 'SET' as const, values: [text('Wood'), text('Aluminum')] };
    const before = resolveEffectiveAttributeValues({ ...input, variantSet });
    expect(before).toMatchObject({
      productRevision: 3,
      source: { level: 'VARIANT', revision: 6 },
      status: 'CURRENT',
      values: variantSet.values,
    });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        productSet: { revision: 4, state: 'SET', values: [text('Stainless')] },
        variantSet,
      }),
    ).toMatchObject({
      productRevision: 4,
      source: { level: 'VARIANT', revision: 6 },
      status: 'CURRENT',
      values: variantSet.values,
    });
    expect(before).toMatchObject({ productRevision: 3, values: variantSet.values });
  });

  it('isolates an explicit Variant override from Product changes and sibling inheritance', () => {
    const override = { revision: 6, state: 'SET' as const, values: [text('Aluminum')] };
    const inheriting = input;
    const overridden = { ...input, variantRef: siblingVariantRef, variantSet: override };
    const stainless = { revision: 4, state: 'SET' as const, values: [text('Stainless')] };

    expect(resolveEffectiveAttributeValues(inheriting)).toMatchObject({
      source: { level: 'PRODUCT', revision: 3 },
      status: 'CURRENT',
      values: [text('Steel')],
    });
    expect(resolveEffectiveAttributeValues(overridden)).toMatchObject({
      source: { level: 'VARIANT', revision: 6 },
      status: 'CURRENT',
      values: [text('Aluminum')],
    });

    expect(resolveEffectiveAttributeValues({ ...inheriting, productSet: stainless })).toMatchObject({
      source: { level: 'PRODUCT', revision: 4 },
      status: 'CURRENT',
      values: [text('Stainless')],
    });
    expect(resolveEffectiveAttributeValues({ ...overridden, productSet: stainless })).toMatchObject({
      source: { level: 'VARIANT', revision: 6 },
      status: 'CURRENT',
      values: [text('Aluminum')],
    });

    expect(resolveEffectiveAttributeValues({ ...inheriting, productSet: null })).toMatchObject({
      status: 'CURRENT',
      values: [],
    });
    expect(resolveEffectiveAttributeValues({ ...overridden, productSet: null })).toMatchObject({
      source: { level: 'VARIANT', revision: 6 },
      status: 'CURRENT',
      values: [text('Aluminum')],
    });

    const removedOverride = { ...overridden, variantSet: { revision: 7, state: 'REMOVED' as const, values: [] } };
    expect(resolveEffectiveAttributeValues({ ...removedOverride, productSet: stainless })).toMatchObject({
      source: { level: 'PRODUCT', revision: 4 },
      status: 'CURRENT',
      values: [text('Stainless')],
      variantRevision: 7,
    });
    expect(resolveEffectiveAttributeValues({ ...removedOverride, productSet: null })).toMatchObject({
      status: 'CURRENT',
      values: [],
      variantRevision: 7,
    });
  });

  it('distinguishes explicit UNKNOWN and NOT_APPLICABLE from absent and removal', () => {
    for (const state of ['UNKNOWN', 'NOT_APPLICABLE'] as const) {
      expect(
        resolveEffectiveAttributeValues({
          ...input,
          variantSet: { revision: 5, state: 'SET', values: [{ kind: 'SPECIAL', state }] },
        }),
      ).toMatchObject({ source: { level: 'VARIANT' }, status: 'CURRENT', values: [{ kind: 'SPECIAL', state }] });
    }
    expect(resolveEffectiveAttributeValues({ ...input, productSet: null })).toMatchObject({
      status: 'CURRENT',
      values: [],
    });
    expect(resolveEffectiveAttributeValues({ ...input, productSet: null })).not.toHaveProperty('source');
    expect(
      resolveEffectiveAttributeValues({ ...input, variantSet: { revision: 7, state: 'REMOVED', values: [] } }),
    ).toMatchObject({ source: { level: 'PRODUCT' }, status: 'CURRENT', values: [text('Steel')] });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        productSet: null,
        variantSet: { revision: 7, state: 'REMOVED', values: [] },
      }),
    ).toMatchObject({ status: 'CURRENT', values: [] });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        productSet: null,
        variantSet: { revision: 7, state: 'REMOVED', values: [] },
      }),
    ).not.toHaveProperty('source');
  });

  it('revalidates an override against the Current definition instead of treating existence as validity', () => {
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        definition: { ...definition, specialStates: [] },
        variantSet: { revision: 8, state: 'SET', values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }] },
      }),
    ).toMatchObject({ status: 'INVALID_VALUE' });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        definition: { ...definition, multiplicity: 'SINGLE' },
        variantSet: { revision: 8, state: 'SET', values: [text('Wood'), text('Aluminum')] },
      }),
    ).toMatchObject({ status: 'INVALID_VALUE' });
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        definition: measuredDefinition,
        variantSet: { revision: 8, state: 'SET', values: [text('Wood')] },
      }),
    ).toMatchObject({ status: 'INVALID_VALUE' });
  });

  it('rejects stale removal basis, missing type authority, disallowed inheritance, and empty SET', () => {
    const removed = { revision: 7, state: 'REMOVED' as const, values: [] };
    const { basis: omittedBasis, ...missingBasis } = input;
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        removalBasis: { productRevision: 2, variantRevision: 7 },
        variantSet: removed,
      }).status,
    ).toBe('STALE_BASIS');
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        removalBasis: { productRevision: 3, variantRevision: 7 },
        variantSet: removed,
      }).status,
    ).toBe('CURRENT');
    expect(omittedBasis).toBeDefined();
    expect(resolveEffectiveAttributeValues(missingBasis).status).toBe('INVALID_AUTHORITY');
    expect(
      resolveEffectiveAttributeValues({ ...input, productSet: { revision: 4, state: 'SET', values: [] } }).status,
    ).toBe('INVALID_AUTHORITY');
    expect(
      resolveEffectiveAttributeValues({
        ...input,
        rulesRevision: { ...rulesRevision, rules: rulesRevision.rules.filter((rule) => rule.level === 'VARIANT') },
      }).status,
    ).toBe('INVALID_AUTHORITY');
  });
});
