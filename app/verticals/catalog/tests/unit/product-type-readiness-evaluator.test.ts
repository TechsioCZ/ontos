import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
} from '../../shared/domain/product-type-rules.ts';
import { evaluateCurrentProductTypeReadiness } from '../../src/persistence/product-type-readiness-evaluator.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const typeRef = {
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
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const basis = Schema.decodeUnknownSync(ProductTypeCurrentBasisSchema)({
  currentRevision: 2,
  effectiveFrom: '2026-09-16T00:00:00.000Z',
  evaluatedAt: '2026-09-17T00:00:00.000Z',
  productTypeRef: typeRef,
  revision: 2,
  revisionId: '66666666-6666-4666-8666-666666666666',
});
const source = {
  assignmentRevision: 3,
  basis,
  productRef,
  rulesRevision: Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
    effectiveFrom: basis.effectiveFrom,
    productTypeRef: typeRef,
    revision: 2,
    revisionId: basis.revisionId,
    rules: [{ attributeDefinitionRef: definitionRef, level: 'VARIANT', required: true }],
  }),
  status: 'VERIFIED',
} as const;

describe('private Product Type readiness evaluation', () => {
  it('stays indeterminate without complete owner Product values', () => {
    expect(
      evaluateCurrentProductTypeReadiness({ productValues: [], source, variantRefs: [], variants: [] }),
    ).toMatchObject({ status: 'INDETERMINATE' });
  });

  it('names a missing required value on its own Variant and preserves exact revisions', () => {
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: { status: 'CURRENT', values: [], variantRevision: 5 },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result).toMatchObject({
      assignmentRevision: 3,
      productValueSourceRevisionTokens: [],
      rules: { violations: [{ kind: 'MISSING_REQUIRED', variantId: variantRef.resourceId }] },
      rulesRevision: 2,
      status: 'INVALID',
      valueRevisions: [{ variantRevision: 5 }],
    });
  });

  it('reports an untyped partial result, never overall readiness', () => {
    expect(
      evaluateCurrentProductTypeReadiness({
        productValues: [],
        productValueSource: { complete: true, revisionTokens: [] },
        source: { productRef, status: 'UNTYPED' },
        variantRefs: [],
        variants: [],
      }).status,
    ).toBe('UNTYPED_PARTIAL');
  });

  it('names a Current Variant fact as disallowed when the Product has no Type', () => {
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source: { productRef, status: 'UNTYPED' },
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [definitionRef.resourceId],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [],
          variantRef,
        },
      ],
    });
    expect(result).toMatchObject({
      rules: { minimumSatisfied: false, violations: [{ kind: 'DISALLOWED', variantId: variantRef.resourceId }] },
      status: 'UNTYPED_PARTIAL',
    });
  });

  it('rejects duplicate and foreign Product value inventories', () => {
    const value = { attributeDefinitionRef: definitionRef, valid: true };
    const base = {
      productValueSource: { complete: true as const, revisionTokens: [] },
      source,
      variantRefs: [],
      variants: [],
    };
    expect(evaluateCurrentProductTypeReadiness({ ...base, productValues: [value, value] }).status).toBe(
      'INDETERMINATE',
    );
    expect(
      evaluateCurrentProductTypeReadiness({
        ...base,
        productValues: [
          { ...value, attributeDefinitionRef: { ...definitionRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
        ],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('rejects foreign or incomplete Variant inventories', () => {
    const base = { productValues: [], productValueSource: { complete: true as const, revisionTokens: [] }, source };
    expect(
      evaluateCurrentProductTypeReadiness({
        ...base,
        variantRefs: [{ ...variantRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
        variants: [],
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      evaluateCurrentProductTypeReadiness({
        ...base,
        variantRefs: [variantRef],
        variants: [{ effectiveValues: [], variantRef }],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('fails an invalid optional effective value rather than treating it as absent', () => {
    const optionalSource = {
      ...source,
      rulesRevision: {
        ...source.rulesRevision,
        rules: [{ attributeDefinitionRef: definitionRef, level: 'VARIANT' as const, required: false }],
      },
    };
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source: optionalSource,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [definitionRef.resourceId],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: { reasons: ['bad value'], status: 'INVALID_VALUE' },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result).toMatchObject({
      rules: { violations: [{ kind: 'INVALID', variantId: variantRef.resourceId }] },
      status: 'INVALID',
    });
  });

  it('rejects mismatched effective source revisions', () => {
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: {
                source: { level: 'VARIANT', productRef, revision: 4, variantRef },
                status: 'CURRENT',
                values: [],
                variantRevision: 5,
              },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result.status).toBe('INDETERMINATE');
  });

  it('fails closed without a complete direct Variant inventory', () => {
    expect(
      evaluateCurrentProductTypeReadiness({
        productValues: [],
        productValueSource: { complete: true, revisionTokens: [] },
        source,
        variantRefs: [variantRef],
        variants: [{ effectiveValues: [], variantRef }],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('rejects a disallowed direct Variant fact even when required effective values are present', () => {
    const disallowedId = '77777777-7777-4777-8777-777777777777';
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [definitionRef.resourceId, disallowedId],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: { status: 'CURRENT', values: [{ kind: 'TEXT', text: 'valid' }], variantRevision: 4 },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result).toMatchObject({
      rules: { violations: [{ attributeDefinitionId: disallowedId, kind: 'DISALLOWED' }] },
      status: 'INVALID',
    });
  });

  it('verifies a required Variant fact supplied by an inherited Product value', () => {
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: {
                productRevision: 7,
                source: { level: 'PRODUCT', productRef, revision: 7 },
                status: 'CURRENT',
                values: [{ kind: 'TEXT', text: 'inherited' }],
                variantRevision: 5,
              },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result).toMatchObject({
      rules: { minimumSatisfied: true, violations: [] },
      status: 'VERIFIED_TYPE_MINIMUM',
    });
  });

  it('fails closed when an inherited Product source revision no longer matches', () => {
    const result = evaluateCurrentProductTypeReadiness({
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source,
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [],
          currentValueSource: { complete: true, revisionTokens: [] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionRef.resourceId,
              result: {
                productRevision: 7,
                source: { level: 'PRODUCT', productRef, revision: 6 },
                status: 'CURRENT',
                values: [{ kind: 'TEXT', text: 'inherited' }],
                variantRevision: 5,
              },
            },
          ],
          variantRef,
        },
      ],
    });
    expect(result.status).toBe('INDETERMINATE');
  });
});
