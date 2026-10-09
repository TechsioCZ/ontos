import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  productCategories,
  productCategoryAssignments,
  productCategoryHierarchyRevisions,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productUnits,
  productUnitRuleRevisions,
  productVariantAxes,
  productVariantAxisEvents,
  productVariants,
  products,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const typeId = '77777777-7777-4777-8777-777777777777';
const typeRevisionId = '88888888-8888-4888-8888-888888888888';
const unitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const leafCategoryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const rootCategoryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-category-test:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'selection-category-test',
};
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;

const selectedWithOrder = (rows: readonly object[]) => ({
  where: () =>
    Object.assign(Effect.succeed(rows), {
      for: () => Object.assign(Effect.succeed(rows), { limit: () => Effect.succeed(rows) }),
      limit: () => Effect.succeed(rows),
      orderBy: () => Object.assign(Effect.succeed(rows), { limit: () => Effect.succeed(rows) }),
    }),
});

type SelectionReadTable =
  | typeof products
  | typeof productVariants
  | typeof productTypeAssignments
  | typeof productTypes
  | typeof productTypeRevisions
  | typeof productTypeRevisionAttributes
  | typeof productVariantAxes
  | typeof productVariantAxisEvents
  | typeof variantUnitDivisibility
  | typeof productUnits
  | typeof productUnitRuleRevisions
  | typeof productCategories
  | typeof productCategoryAssignments
  | typeof productCategoryHierarchyRevisions;

const baseRows = (): Map<SelectionReadTable, readonly object[]> =>
  new Map<SelectionReadTable, readonly object[]>([
    [products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]],
    [productVariants, [{ currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId }]],
    [productTypeAssignments, [{ assignmentRevision: 1, productId, productTypeId: typeId, tenantId }]],
    [productTypes, [{ currentRevision: 2, productTypeId: typeId, tenantId }]],
    [
      productTypeRevisions,
      [
        {
          effectiveAt: new Date('1960-01-01T00:00:00.000Z'),
          productTypeId: typeId,
          productTypeRevisionId: typeRevisionId,
          revision: 2,
          tenantId,
        },
      ],
    ],
    [productTypeRevisionAttributes, []],
    [productVariantAxes, []],
    [
      productVariantAxisEvents,
      [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 3, productId, tenantId }],
    ],
    [variantUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId, variantId }]],
    [productUnits, [{ currentRuleRevision: 2, lifecycleState: 'ACTIVE', unitId }]],
    [productUnitRuleRevisions, [{ lifecycleState: 'ACTIVE', revision: 2, rounding: 'UP', step: '1' }]],
  ]);

const categoryRows = (): Map<SelectionReadTable, readonly object[]> =>
  new Map<SelectionReadTable, readonly object[]>([
    [productCategoryHierarchyRevisions, [{ assignmentRevision: 3, hierarchyRevision: 4, tenantId }]],
    [productCategoryAssignments, [{ categoryId: leafCategoryId, productId, tenantId }]],
    [
      productCategories,
      [
        {
          categoryId: leafCategoryId,
          currentRevision: 2,
          lifecycleState: 'ACTIVE',
          name: 'Bike',
          parentCategoryId: rootCategoryId,
          tenantId,
        },
        {
          categoryId: rootCategoryId,
          currentRevision: 5,
          lifecycleState: 'ACTIVE',
          name: 'Sport',
          parentCategoryId: null,
          tenantId,
        },
      ],
    ],
  ]);

const readWith = (
  rows: Map<SelectionReadTable, readonly object[]>,
  purpose: string,
  options: { readonly throwOnCategory?: boolean } = {},
) => {
  const transaction = {
    select: () => ({
      from: (table: SelectionReadTable) => {
        if (
          options.throwOnCategory === true &&
          (table === productCategories ||
            table === productCategoryAssignments ||
            table === productCategoryHierarchyRevisions)
        ) {
          throw new Error('Category facts must not be read for this purpose');
        }
        return selectedWithOrder(rows.get(table) ?? []);
      },
    }),
  };
  // @ts-expect-error The mock implements only the exercised owner read chains.
  return catalogSelectionCurrentBasisForScope(transaction, scope).read({ purpose, selection });
};

describe('Catalog Selection category basis', () => {
  it.effect('issues the exact Category and ancestor basis for Pricing', () =>
    Effect.gen(function* pricingCategoryBasis() {
      const result = yield* readWith(new Map([...baseRows(), ...categoryRows()]), 'PRICING');
      expect(result.status).toBe('OBSERVED');
      if (result.status !== 'OBSERVED') {
        return;
      }
      expect(result.dependentFactsComplete).toBe(true);
      expect(
        result.basis
          .filter(({ role }) => role === 'CATEGORY')
          .map(({ source }) => [source.resourceRef.resourceId, source.revision]),
      ).toEqual([
        [leafCategoryId, 2],
        [rootCategoryId, 5],
      ]);
      expect(
        assessCatalogSelection({
          assessedAt: result.assessedAt,
          current: result,
          purpose: 'PRICING',
          selection,
        }).status,
      ).toBe('VALID');
    }),
  );

  it.effect('treats an absent Category classification as incomplete for Assortment', () =>
    Effect.gen(function* assortmentWithoutCategory() {
      const result = yield* readWith(baseRows(), 'ASSORTMENT');
      expect(result.status).toBe('OBSERVED');
      if (result.status !== 'OBSERVED') {
        return;
      }
      expect(result.dependentFactsComplete).toBe(false);
      expect(result.basis.some(({ role }) => role === 'CATEGORY')).toBe(false);
      expect(
        assessCatalogSelection({
          assessedAt: result.assessedAt,
          current: result,
          purpose: 'ASSORTMENT',
          selection,
        }).status,
      ).toBe('INDETERMINATE');
    }),
  );

  it.effect('does not read or carry Category facts for purchase acceptance', () =>
    Effect.gen(function* purchaseAcceptanceWithoutCategory() {
      const result = yield* readWith(new Map([...baseRows(), ...categoryRows()]), 'PURCHASE_ACCEPTANCE', {
        throwOnCategory: true,
      });
      expect(result.status).toBe('OBSERVED');
      if (result.status !== 'OBSERVED') {
        return;
      }
      expect(result.dependentFactsComplete).toBe(true);
      expect(result.basis.some(({ role }) => role === 'CATEGORY')).toBe(false);
    }),
  );

  it.effect('does not present evidence issued at t0 as valid at t1', () =>
    Effect.gen(function* pointInTime() {
      const result = yield* readWith(new Map([...baseRows(), ...categoryRows()]), 'PRICING');
      expect(result.status).toBe('OBSERVED');
      if (result.status !== 'OBSERVED') {
        return;
      }
      expect(
        assessCatalogSelection({
          assessedAt: result.assessedAt,
          current: result,
          purpose: 'PRICING',
          selection,
        }).status,
      ).toBe('VALID');
      const later = new Date(Date.parse(result.assessedAt) + 1000).toISOString();
      const reused = assessCatalogSelection({
        assessedAt: later,
        current: result,
        purpose: 'PRICING',
        selection,
      });
      expect(reused.status).toBe('INDETERMINATE');
      expect(reused.assessedAt).toBe(later);
    }),
  );
});
