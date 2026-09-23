import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { ProductTypeRulesRevisionSchema } from '../../shared/domain/product-type-rules.ts';
import {
  ProductTypeCreateConflict,
  mapProductTypeCreateWriteError,
  validProductTypeRuleDefinitions,
} from '../../src/persistence/product-type-create-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const attributeDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;

describe('Product Type create persistence', () => {
  it('classifies only exact owned duplicate constraints as conflicts', () => {
    for (const [constraint, conflict] of [
      ['product_types_pkey', 'PRODUCT_TYPE_ID'],
      ['catalog_product_types_scope_id_uk', 'PRODUCT_TYPE_ID'],
      ['catalog_product_type_revisions_invocation_uk', 'ACTION_INVOCATION_ID'],
    ] as const) {
      const error = mapProductTypeCreateWriteError({ code: '23505', constraint });
      expect(Schema.is(ProductTypeCreateConflict)(error)).toBe(true);
      expect(error).toMatchObject({ conflict });
    }
    for (const driverError of [
      { code: '08006', constraint: 'product_types_pkey' },
      { code: '23505', constraint: 'foreign_constraint' },
      new Error('duplicate Product Type'),
    ]) {
      const error = mapProductTypeCreateWriteError(driverError);
      expect(Schema.is(CatalogPersistenceUnavailable)(error)).toBe(true);
      expect(error.cause).toBe(driverError);
    }
  });

  it('validates the initial revision before any create write can be attempted', () => {
    const decode = Schema.decodeUnknownSync(ProductTypeRulesRevisionSchema);
    const base = { productTypeRef, revision: 1 } as const;
    const rule = { attributeDefinitionRef, level: 'PRODUCT', required: true } as const;
    expect(decode({ ...base, rules: [] }).rules).toEqual([]);
    expect(decode({ ...base, rules: [rule] }).rules).toHaveLength(1);
    expect(() => decode({ ...base, rules: [rule, rule] })).toThrow();
    expect(() =>
      decode({
        ...base,
        rules: [
          {
            ...rule,
            attributeDefinitionRef: { ...attributeDefinitionRef, tenantId: '99999999-9999-4999-8999-999999999999' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects missing, foreign-tenant, and level-inapplicable Definitions before rule inserts', () => {
    const productRule = { attributeDefinitionRef, level: 'PRODUCT', required: true } as const;
    const variantRule = { attributeDefinitionRef, level: 'VARIANT', required: false } as const;
    const definition = {
      applicableLevels: ['PRODUCT'],
      attributeDefinitionId: attributeDefinitionRef.resourceId,
      tenantId,
    } as const;
    expect(validProductTypeRuleDefinitions([productRule], [definition], tenantId)).toBe(true);
    expect(validProductTypeRuleDefinitions([productRule], [], tenantId)).toBe(false);
    expect(validProductTypeRuleDefinitions([variantRule], [definition], tenantId)).toBe(false);
    expect(
      validProductTypeRuleDefinitions(
        [productRule],
        [{ ...definition, tenantId: '99999999-9999-4999-8999-999999999999' }],
        tenantId,
      ),
    ).toBe(false);
    expect(
      validProductTypeRuleDefinitions(
        [productRule, variantRule],
        [{ ...definition, applicableLevels: ['PRODUCT', 'VARIANT'] }],
        tenantId,
      ),
    ).toBe(true);
  });
});
