import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogSelectionBasisSchema, CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  requiredCatalogSelectionRoles,
  selectSmallestCompleteCatalogSelectionBasis,
} from '../../shared/domain/catalog-selection-purpose.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const typeRef = ref('commerce.catalog.product-type', '44444444-4444-4444-8444-444444444444');
const attrDefRef = ref('commerce.catalog.attribute-definition', '55555555-5555-4555-8555-555555555555');
const valueSetRef = ref('commerce.catalog.attribute-value-set', '66666666-6666-4666-8666-666666666666');
const configDefRef = ref('commerce.catalog.configuration-definition', '77777777-7777-4777-8777-777777777777');
const unitRef = ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888');
const unitRuleRef = ref('commerce.catalog.product-unit', '99999999-9999-4999-8999-999999999999');
const packageRef = ref('commerce.catalog.package-definition', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const setRef = ref('commerce.catalog.set-composition', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const categoryRef = ref('commerce.catalog.product-category', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const rootCategoryRef = ref('commerce.catalog.product-category', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

const decodeSelection = Schema.decodeUnknownSync(CatalogSelectionSchema, { onExcessProperty: 'error' });
const decodeBasis = Schema.decodeUnknownSync(CatalogSelectionBasisSchema, { onExcessProperty: 'error' });

const fact = (role: string, resourceRef: ReturnType<typeof ref>, revision: number) =>
  decodeBasis({ role, source: { resourceRef, revision } });

const selection = decodeSelection({ productRef, variantRef });
const baseFacts = [
  fact('PRODUCT', productRef, 1),
  fact('VARIANT', variantRef, 2),
  fact('PRODUCT_TYPE', typeRef, 1),
  fact('VARIANT_AXIS', productRef, 3),
  fact('INHERITED_VALUE', valueSetRef, 4),
  fact('UNIT_RULE', unitRuleRef, 1),
  fact('UNIT_TARGET_DIVISIBILITY', variantRef, 5),
];
const valueValidityFacts = [fact('OTHER_CATALOG_FACT', valueSetRef, 6), fact('ATTRIBUTE_DEFINITION', attrDefRef, 7)];

describe('Catalog Selection purpose minimalisation', () => {
  it('keeps the complete axis and value validity basis for purchase acceptance', () => {
    const result = selectSmallestCompleteCatalogSelectionBasis({
      basis: [...baseFacts, ...valueValidityFacts],
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.status).toBe('COMPLETE');
    if (result.status !== 'COMPLETE') {
      return;
    }
    expect(result.basis.map(({ role }) => role)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'VARIANT_AXIS',
      'INHERITED_VALUE',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
      'OTHER_CATALOG_FACT',
      'ATTRIBUTE_DEFINITION',
    ]);
  });

  it('does not require inherited-value evidence when the selection inherits no value', () => {
    const result = selectSmallestCompleteCatalogSelectionBasis({
      basis: baseFacts.filter(({ role }) => role !== 'INHERITED_VALUE'),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.status).toBe('COMPLETE');
    if (result.status === 'COMPLETE') {
      expect(result.basis.some(({ role }) => role === 'INHERITED_VALUE')).toBe(false);
    }
  });

  it('uses an exclusive confirmed-untyped decision instead of Product Type and Variant-axis facts', () => {
    const untyped = decodeBasis({
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 6 },
    });
    const result = selectSmallestCompleteCatalogSelectionBasis({
      basis: [
        fact('PRODUCT', productRef, 1),
        fact('VARIANT', variantRef, 2),
        untyped,
        fact('UNIT_RULE', unitRuleRef, 1),
        fact('UNIT_TARGET_DIVISIBILITY', variantRef, 5),
      ],
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result).toMatchObject({ status: 'COMPLETE' });
    if (result.status === 'COMPLETE') {
      expect(result.basis.map(({ role }) => role)).toEqual([
        'PRODUCT',
        'VARIANT',
        'PRODUCT_TYPE_UNTYPED_DECISION',
        'UNIT_RULE',
        'UNIT_TARGET_DIVISIBILITY',
      ]);
    }
    expect(
      selectSmallestCompleteCatalogSelectionBasis({
        basis: [...baseFacts, untyped],
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
      }),
    ).toMatchObject({ status: 'INCOMPLETE' });
  });

  it('reports every missing deciding role instead of estimating it', () => {
    const result = selectSmallestCompleteCatalogSelectionBasis({
      basis: [fact('PRODUCT', productRef, 1), fact('VARIANT', variantRef, 2)],
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result).toEqual({
      missingRoles: ['PRODUCT_TYPE', 'VARIANT_AXIS', 'UNIT_RULE', 'UNIT_TARGET_DIVISIBILITY'],
      status: 'INCOMPLETE',
    });
  });

  it('keeps Product/Variant identity and every pinned selected revision', () => {
    const configuredPackedSet = decodeSelection({
      configuration: {
        choices: [
          { attributeDefinition: { resourceRef: attrDefRef, revision: 4 }, choiceKey: 'mount', value: 'A' },
          { choiceKey: 'length', unit: { resourceRef: unitRef, revision: 5 }, value: '83' },
        ],
        definition: { resourceRef: configDefRef, revision: 3 },
        productRef,
        variantRef,
      },
      packageOption: { contentRevision: { resourceRef: packageRef, revision: 1 }, optionRef: packageRef },
      productRef,
      setComposition: { resourceRef: setRef, revision: 2 },
      variantRef,
    });
    const subject = {
      componentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      composition: { resourceRef: setRef, revision: 2 },
      kind: 'SET_COMPONENT',
    };
    const componentFact = decodeBasis({ role: 'VARIANT', source: { resourceRef: variantRef, revision: 9 }, subject });
    const basis = [
      fact('PRODUCT', productRef, 1),
      fact('VARIANT', variantRef, 2),
      fact('PRODUCT_TYPE', typeRef, 1),
      fact('PACKAGE_CONTENT', packageRef, 1),
      fact('SET_COMPOSITION', setRef, 2),
      fact('CONFIGURATION_DEFINITION', configDefRef, 3),
      fact('ATTRIBUTE_DEFINITION', attrDefRef, 4),
      fact('UNIT', unitRef, 5),
      componentFact,
      fact('OTHER_CATALOG_FACT', valueSetRef, 6),
    ];
    const result = selectSmallestCompleteCatalogSelectionBasis({
      basis,
      purpose: 'ORDER_HISTORY',
      selection: configuredPackedSet,
    });
    expect(result.status).toBe('COMPLETE');
    if (result.status !== 'COMPLETE') {
      return;
    }
    expect(result.basis.map(({ role }) => role)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'PACKAGE_CONTENT',
      'SET_COMPOSITION',
      'CONFIGURATION_DEFINITION',
      'ATTRIBUTE_DEFINITION',
      'UNIT',
      'VARIANT',
    ]);
    expect(result.basis.at(-1)?.subject).toMatchObject(subject);
    expect(
      selectSmallestCompleteCatalogSelectionBasis({
        basis: basis.filter((entry) => entry.role !== 'UNIT'),
        purpose: 'ORDER_HISTORY',
        selection: configuredPackedSet,
      }),
    ).toEqual({ missingRoles: ['UNIT'], status: 'INCOMPLETE' });
  });

  it('requires Category for Pricing/Assortment and never widens another purpose', () => {
    expect(requiredCatalogSelectionRoles('PURCHASE_ACCEPTANCE', selection)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'VARIANT_AXIS',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
    ]);
    expect(requiredCatalogSelectionRoles('PRICING', selection)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'CATEGORY',
    ]);
    const categoryFacts = [
      fact('PRODUCT', productRef, 1),
      fact('VARIANT', variantRef, 2),
      fact('CATEGORY', categoryRef, 1),
      fact('CATEGORY', rootCategoryRef, 2),
      fact('PRODUCT_TYPE', typeRef, 1),
    ];
    const pricing = selectSmallestCompleteCatalogSelectionBasis({
      basis: categoryFacts,
      purpose: 'PRICING',
      selection,
    });
    expect(pricing.status).toBe('COMPLETE');
    if (pricing.status === 'COMPLETE') {
      expect(pricing.basis.map(({ role }) => role)).toEqual([
        'PRODUCT',
        'VARIANT',
        'CATEGORY',
        'CATEGORY',
        'PRODUCT_TYPE',
      ]);
    }
    expect(
      selectSmallestCompleteCatalogSelectionBasis({ basis: categoryFacts, purpose: 'ORDER_HISTORY', selection }),
    ).toEqual({ basis: [categoryFacts[0], categoryFacts[1], categoryFacts[4]], status: 'COMPLETE' });
  });

  it('retains the exclusive confirmed-untyped proof for every VALID purpose', () => {
    const untyped = decodeBasis({
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 6 },
    });
    for (const purpose of ['PRICING', 'ASSORTMENT', 'AVAILABILITY_ELIGIBILITY', 'ORDER_HISTORY'] as const) {
      const result = selectSmallestCompleteCatalogSelectionBasis({
        basis: [
          fact('PRODUCT', productRef, 1),
          fact('VARIANT', variantRef, 2),
          untyped,
          ...(purpose === 'PRICING' || purpose === 'ASSORTMENT' ? [fact('CATEGORY', categoryRef, 1)] : []),
        ],
        purpose,
        selection,
      });
      expect(result.status).toBe('COMPLETE');
      if (result.status === 'COMPLETE') {
        expect(result.basis.filter(({ role }) => role === 'PRODUCT_TYPE_UNTYPED_DECISION')).toEqual([untyped]);
      }
    }
  });
});
