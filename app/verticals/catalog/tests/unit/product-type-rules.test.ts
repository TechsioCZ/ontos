import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ProductTypeRulesRevisionSchema,
  ProductTypeCurrentRulesRevisionSchema,
  ProductTypeSubjectSchema,
  evaluateProductTypeRules,
} from '../../shared/domain/product-type-rules.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const otherVariantRef = { ...variantRef, resourceId: '55555555-5555-4555-8555-555555555555' } as const;
const material = {
  moduleId: 'commerce.catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const note = { ...material, resourceId: '77777777-7777-4777-8777-777777777777' } as const;
const length = { ...material, resourceId: '88888888-8888-4888-8888-888888888888' } as const;
const motorPower = { ...material, resourceId: '99999999-9999-4999-8999-999999999999' } as const;
const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const evaluatedAt = '2026-09-17T00:00:00.000Z';
const revision = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
  effectiveFrom,
  productTypeRef,
  revision: 1,
  revisionId,
  rules: [
    { attributeDefinitionRef: material, level: 'PRODUCT', required: true },
    { attributeDefinitionRef: note, level: 'PRODUCT', required: false },
    { attributeDefinitionRef: length, level: 'VARIANT', required: true },
  ],
});
const basis = { currentRevision: 1, effectiveFrom, evaluatedAt, productTypeRef, revision: 1, revisionId } as const;

describe('Product Type allowed and required rules', () => {
  it('names missing required Product and specific Variant values, never borrowing from a sibling', () => {
    const result = evaluateProductTypeRules(
      {
        currentProductTypeRef: productTypeRef,
        productRef,
        productValues: [],
        variants: [
          { effectiveValues: [], productRef, variantRef },
          {
            effectiveValues: [{ attributeDefinitionRef: length, valid: true }],
            productRef,
            variantRef: otherVariantRef,
          },
        ],
      },
      revision,
      basis,
    );
    expect(result.minimumSatisfied).toBe(false);
    expect(result.violations).toEqual([
      { attributeDefinitionId: material.resourceId, kind: 'MISSING_REQUIRED', level: 'PRODUCT' },
      {
        attributeDefinitionId: length.resourceId,
        kind: 'MISSING_REQUIRED',
        level: 'VARIANT',
        variantId: variantRef.resourceId,
      },
    ]);
  });

  it('allows absent optional values but rejects invalid optional and disallowed Current facts', () => {
    const base = {
      currentProductTypeRef: productTypeRef,
      productRef,
      productValues: [{ attributeDefinitionRef: material, valid: true }],
      variants: [{ effectiveValues: [{ attributeDefinitionRef: length, valid: true }], productRef, variantRef }],
    } as const;
    expect(evaluateProductTypeRules(base, revision, basis)).toEqual({
      basisStatus: 'CURRENT',
      minimumSatisfied: true,
      revision: 1,
      revisionContext: basis,
      violations: [],
    });
    const result = evaluateProductTypeRules(
      {
        ...base,
        productValues: [
          ...base.productValues,
          { attributeDefinitionRef: note, valid: false },
          { attributeDefinitionRef: motorPower, valid: true },
        ],
      },
      revision,
      basis,
    );
    expect(result.violations.map((v) => v.kind)).toEqual(['INVALID', 'DISALLOWED']);
  });

  it('gives an untyped Product an empty allowed set and fails closed on mismatched rules', () => {
    const base = {
      productRef,
      productValues: [{ attributeDefinitionRef: material, valid: true }],
      variants: [],
    } as const;
    expect(evaluateProductTypeRules(base).violations[0]?.kind).toBe('DISALLOWED');
    expect(evaluateProductTypeRules({ ...base, productValues: [] }).minimumSatisfied).toBe(false);
    expect(
      evaluateProductTypeRules({ ...base, currentProductTypeRef: productTypeRef, productValues: [] }).minimumSatisfied,
    ).toBe(false);
  });

  it('rejects duplicate rules and cross-tenant Attribute Definitions', () => {
    const decode = Schema.decodeUnknownSync(ProductTypeRulesRevisionSchema);
    expect(() =>
      decode({
        productTypeRef,
        revision: 2,
        rules: [
          { attributeDefinitionRef: material, level: 'PRODUCT', required: true },
          { attributeDefinitionRef: material, level: 'PRODUCT', required: false },
        ],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
        ...revision,
        rules: [
          { attributeDefinitionRef: material, level: 'PRODUCT', required: true },
          { attributeDefinitionRef: material, level: 'PRODUCT', required: false },
        ],
      }),
    ).toThrow();
    expect(
      evaluateProductTypeRules(
        { currentProductTypeRef: productTypeRef, productRef, productValues: [], variants: [] },
        {
          ...revision,
          rules: [...revision.rules, { attributeDefinitionRef: material, level: 'PRODUCT', required: true }],
        },
        basis,
      ).basisStatus,
    ).toBe('MALFORMED');
    expect(() =>
      decode({
        productTypeRef,
        revision: 2,
        rules: [
          {
            attributeDefinitionRef: { ...material, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            level: 'PRODUCT',
            required: true,
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects cross-tenant type assignments, values, and Variants in the subject', () => {
    const decode = Schema.decodeUnknownSync(ProductTypeSubjectSchema);
    const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const base = { currentProductTypeRef: productTypeRef, productRef, productValues: [], variants: [] } as const;
    expect(() =>
      decode({ ...base, currentProductTypeRef: { ...productTypeRef, tenantId: foreignTenantId } }),
    ).toThrow();
    expect(() =>
      decode({
        ...base,
        productValues: [{ attributeDefinitionRef: { ...material, tenantId: foreignTenantId }, valid: true }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...base,
        variants: [{ effectiveValues: [], productRef, variantRef: { ...variantRef, tenantId: foreignTenantId } }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...base,
        variants: [
          {
            effectiveValues: [],
            productRef: { ...productRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
            variantRef,
          },
        ],
      }),
    ).toThrow();
  });

  it('fails closed on ambiguous Current facts and duplicate Variant identities', () => {
    const base = { currentProductTypeRef: productTypeRef, productRef, productValues: [], variants: [] } as const;
    const duplicateValues = {
      ...base,
      productValues: [
        { attributeDefinitionRef: material, valid: true },
        { attributeDefinitionRef: material, valid: false },
      ],
    } as const;
    expect(evaluateProductTypeRules(duplicateValues, revision, basis).basisStatus).toBe('MALFORMED');
    const variant = { effectiveValues: [{ attributeDefinitionRef: length, valid: true }], productRef, variantRef };
    expect(evaluateProductTypeRules({ ...base, variants: [variant, variant] }, revision, basis).basisStatus).toBe(
      'MALFORMED',
    );
    expect(
      evaluateProductTypeRules(
        {
          ...base,
          variants: [{ ...variant, effectiveValues: [...variant.effectiveValues, ...variant.effectiveValues] }],
        },
        revision,
        basis,
      ).basisStatus,
    ).toBe('MALFORMED');
  });

  it('keeps untyped empty facts distinct from unknown rules and an incomplete typed draft', () => {
    const untyped = { productRef, productValues: [], variants: [] } as const;
    expect(evaluateProductTypeRules(untyped)).toEqual({
      basisStatus: 'UNTYPED',
      minimumSatisfied: false,
      violations: [],
    });
    expect(
      evaluateProductTypeRules({
        ...untyped,
        variants: [{ effectiveValues: [], productRef, variantRef }],
      }),
    ).toEqual({ basisStatus: 'UNTYPED', minimumSatisfied: false, violations: [] });
    expect(evaluateProductTypeRules({ ...untyped, currentProductTypeRef: productTypeRef })).toEqual({
      basisStatus: 'MISSING',
      minimumSatisfied: false,
      violations: [],
    });
    const typed = evaluateProductTypeRules({ ...untyped, currentProductTypeRef: productTypeRef }, revision, basis);
    expect(typed.basisStatus).toBe('CURRENT');
    expect(typed.minimumSatisfied).toBe(false);
    expect(typed.violations).toContainEqual({
      attributeDefinitionId: material.resourceId,
      kind: 'MISSING_REQUIRED',
      level: 'PRODUCT',
    });
  });

  it('reports an invalid required value as both invalid and unsatisfied', () => {
    const result = evaluateProductTypeRules(
      {
        currentProductTypeRef: productTypeRef,
        productRef,
        productValues: [{ attributeDefinitionRef: material, valid: false }],
        variants: [{ effectiveValues: [{ attributeDefinitionRef: length, valid: true }], productRef, variantRef }],
      },
      revision,
      basis,
    );
    expect(result.minimumSatisfied).toBe(false);
    expect(result.violations).toEqual([
      { attributeDefinitionId: material.resourceId, kind: 'INVALID', level: 'PRODUCT' },
      { attributeDefinitionId: material.resourceId, kind: 'MISSING_REQUIRED', level: 'PRODUCT' },
    ]);
  });

  it('requires exact Current revision identity and an effective canonical time basis', () => {
    const subject = { currentProductTypeRef: productTypeRef, productRef, productValues: [], variants: [] } as const;
    expect(evaluateProductTypeRules(subject, revision).basisStatus).toBe('MISSING');
    expect(
      evaluateProductTypeRules(subject, revision, { ...basis, revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
        .basisStatus,
    ).toBe('STALE_REVISION');
    expect(evaluateProductTypeRules(subject, revision, { ...basis, currentRevision: 2 }).basisStatus).toBe(
      'STALE_REVISION',
    );
    expect(
      evaluateProductTypeRules(subject, revision, {
        ...basis,
        productTypeRef: { ...productTypeRef, resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      }).basisStatus,
    ).toBe('WRONG_TYPE');
    expect(
      evaluateProductTypeRules(subject, revision, { ...basis, evaluatedAt: '2026-08-31T00:00:00.000Z' }).basisStatus,
    ).toBe('NOT_EFFECTIVE');
    expect(
      evaluateProductTypeRules(subject, revision, { ...basis, effectiveUntil: '2026-09-17T00:00:00.000Z' }).basisStatus,
    ).toBe('NOT_EFFECTIVE');
    expect(evaluateProductTypeRules(subject, revision, { ...basis, evaluatedAt: 'not-a-time' }).basisStatus).toBe(
      'MALFORMED',
    );
  });
});
