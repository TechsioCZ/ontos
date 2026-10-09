import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogStockDemandSchema,
  CatalogToStockBindingSchema,
  makeCatalogToStockBindingResolver,
  ResolvedCatalogStockDemandSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CatalogStockDemand, CatalogToStockBinding } from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  PackageStockItemBindingRejected,
  resolvePackageStockRequirement,
} from '../../shared/domain/package-stock-item-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const packageDefinitionId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-24T10:00:00.000Z';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const packageSelection = (contentRevision: number) =>
  Schema.decodeUnknownSync(CatalogSelectionSchema)({
    packageOption: {
      contentRevision: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: packageDefinitionId,
          resourceType: 'commerce.catalog.package-definition',
          tenantId,
        },
        revision: contentRevision,
      },
      optionRef: {
        moduleId: 'commerce.catalog',
        resourceId: packageDefinitionId,
        resourceType: 'commerce.catalog.package-definition',
        tenantId,
      },
    },
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  });

const ordinarySelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});

const meaning = (revision: number) =>
  ({ id: `catalog-owner:package-selection:content-${revision}`, kind: 'PACKAGE_OPTION' }) as const;

const stockItem = (revision: number, stockItemId: string) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: timestamp,
    exactSelectionMeaning: meaning(revision),
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: stockItemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef,
  });

const binding = (revision: number, bindingId: string, item: StockItem) =>
  Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: bindingId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: packageSelection(revision),
    effectiveFrom: timestamp,
    exactSelectionMeaning: meaning(revision),
    revision: 1,
    stockItemRef: item.stockItemRef,
    unitRef,
  });

const demand = (contentRevision: number, quantity = '2') =>
  Schema.decodeUnknownSync(CatalogStockDemandSchema)({
    catalogSelection: packageSelection(contentRevision),
    exactSelectionMeaning: meaning(contentRevision),
    purchaseDemandOccurrenceId: `purchase-demand:package:${contentRevision}`,
    quantity,
    unitRef,
  });

const makeResolver = (bindings: readonly CatalogToStockBinding[], items: readonly StockItem[]) => {
  const bindingReader = {
    findCurrentByExactSelectionMeaning: (
      requestedTenantId: string,
      requestedMeaning: StockItem['exactSelectionMeaning'],
    ) =>
      Effect.succeed(
        bindings.filter(
          (candidate) =>
            candidate.bindingRef.tenantId === requestedTenantId &&
            candidate.exactSelectionMeaning.id === requestedMeaning.id &&
            candidate.exactSelectionMeaning.kind === requestedMeaning.kind,
        ),
      ),
  };
  const stockItemReader = {
    findById: (requestedTenantId: string, stockItemId: string) =>
      Effect.succeed(
        Option.fromNullishOr(
          items.find(
            (candidate) =>
              candidate.stockItemRef.tenantId === requestedTenantId &&
              candidate.stockItemRef.resourceId === stockItemId,
          ),
        ),
      ),
  };
  return makeCatalogToStockBindingResolver(bindingReader, stockItemReader);
};

const resolvedDemand = (request: CatalogStockDemand, item: StockItem) =>
  Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
    ...request,
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    stockItem: item,
  });

describe('Package Stock Item Binding', () => {
  it.effect('keeps two requested Package units as one Package Stock Item demand without decomposing contents', () =>
    Effect.gen(function* keepPackageDemandIntact() {
      const item = stockItem(1, '66666666-6666-4666-8666-666666666666');
      const current = binding(1, '77777777-7777-4777-8777-777777777777', item);

      const catalogDemand = yield* makeResolver([current], [item]).resolve(demand(1));
      const resolved = yield* resolvePackageStockRequirement(catalogDemand);

      expect(resolved).toMatchObject({
        catalogSelection: packageSelection(1),
        exactSelectionMeaning: meaning(1),
        quantity: '2',
        stockItem: item,
        unitRef,
      });
      expect(resolved.contentDecomposition).toBe('PROHIBITED');
      expect(resolved.stockRepresentation).toBe('ONE_EXACT_PACKAGE_STOCK_ITEM');
      expect(resolved.packageContentRevision.revision).toBe(1);
      expect(resolved.catalogSelection.packageOption?.contentRevision.revision).toBe(1);
      expect(resolved).not.toHaveProperty('componentRequirements');
      expect(resolved).not.toHaveProperty('containedPieceQuantity');
      expect(resolved).not.toHaveProperty('convertedQuantity');
    }),
  );

  it.effect('does not treat quantity-entry convenience as a Package Option', () =>
    Effect.gen(function* rejectConvenienceAsPackage() {
      const item = stockItem(1, '66666666-6666-4666-8666-666666666666');
      const request = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
        ...demand(1),
        catalogSelection: ordinarySelection,
      });

      const error = yield* resolvePackageStockRequirement(resolvedDemand(request, item)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PackageStockItemBindingRejected);
      expect(error.reason).toBe('PACKAGE_CONTENT_REVISION_MISSING');
    }),
  );

  it.effect('requires Catalog to identify the Selection meaning as a Package Option', () =>
    Effect.gen(function* requirePackageMeaning() {
      const request = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
        ...demand(1),
        exactSelectionMeaning: {
          id: 'catalog-owner:ordinary-variant',
          kind: 'PRODUCT_VARIANT',
        },
      });

      const variantItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem(1, '66666666-6666-4666-8666-666666666666'),
        exactSelectionMeaning: request.exactSelectionMeaning,
      });
      const error = yield* resolvePackageStockRequirement(resolvedDemand(request, variantItem)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PackageStockItemBindingRejected);
      expect(error.reason).toBe('EXACT_SELECTION_IS_NOT_A_PACKAGE');
    }),
  );

  it.effect(
    'maps a material content revision to a new exact meaning and a new Stock Item without rewriting history',
    () =>
      Effect.gen(function* preserveMaterialRevisionHistory() {
        const firstItem = stockItem(1, '66666666-6666-4666-8666-666666666666');
        const secondItem = stockItem(2, '88888888-8888-4888-8888-888888888888');
        const firstBinding = binding(1, '77777777-7777-4777-8777-777777777777', firstItem);
        const secondBinding = binding(2, '99999999-9999-4999-8999-999999999999', secondItem);
        const resolver = makeResolver([firstBinding, secondBinding], [firstItem, secondItem]);

        const original = yield* resolver.resolve(demand(1)).pipe(Effect.flatMap(resolvePackageStockRequirement));
        const revised = yield* resolver.resolve(demand(2)).pipe(Effect.flatMap(resolvePackageStockRequirement));

        expect(packageSelection(1).packageOption?.optionRef.resourceId).toBe(
          packageSelection(2).packageOption?.optionRef.resourceId,
        );
        expect(original.catalogSelection.packageOption?.contentRevision.revision).toBe(1);
        expect(revised.catalogSelection.packageOption?.contentRevision.revision).toBe(2);
        expect(original.exactSelectionMeaning.id).not.toBe(revised.exactSelectionMeaning.id);
        expect(original.stockItem.stockItemRef.resourceId).not.toBe(revised.stockItem.stockItemRef.resourceId);
        expect(original.stockItem).toEqual(firstItem);
      }),
  );

  it.effect('rejects reuse of the historical Package Stock Item for a new exact Package meaning', () =>
    Effect.gen(function* rejectHistoricalItemReuse() {
      const historicalItem = stockItem(1, '66666666-6666-4666-8666-666666666666');
      const erroneousBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding(2, '99999999-9999-4999-8999-999999999999', stockItem(2, historicalItem.stockItemRef.resourceId)),
        stockItemRef: historicalItem.stockItemRef,
      });

      const error = yield* makeResolver([erroneousBinding], [historicalItem]).resolve(demand(2)).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: 'INTRINSIC_MEANING_MISMATCH' });
      expect(historicalItem.exactSelectionMeaning).toEqual(meaning(1));
    }),
  );
});
