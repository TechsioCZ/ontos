import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  FixedSetStockItemBindingRejected,
  resolveFixedSetStockRequirement,
} from '../../shared/domain/fixed-set-stock-item-binding.ts';
import {
  CatalogStockDemandSchema,
  CatalogToStockBindingSchema,
  makeCatalogToStockBindingResolver,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CatalogToStockBinding } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-24T12:00:00.000Z';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const compositionId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const selectionAt = (revision: number) =>
  Schema.decodeUnknownSync(CatalogSelectionSchema)({
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: productId,
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    setComposition: {
      resourceRef: {
        moduleId: 'commerce.catalog',
        resourceId: compositionId,
        resourceType: 'commerce.catalog.set-composition',
        tenantId,
      },
      revision,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: variantId,
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  });

const meaningAt = (revision: number) =>
  ({ id: `catalog-owner:set-${variantId}:composition-${revision}`, kind: 'SET_VARIANT' }) as const;

const stockItemAt = (revision: number) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: timestamp,
    exactSelectionMeaning: meaningAt(revision),
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: `66666666-6666-4666-8666-66666666666${revision}`,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef,
  });

const bindingAt = (revision: number, stockItem: StockItem) =>
  Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: `77777777-7777-4777-8777-77777777777${revision}`,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: selectionAt(revision),
    effectiveFrom: timestamp,
    exactSelectionMeaning: meaningAt(revision),
    revision: 1,
    stockItemRef: stockItem.stockItemRef,
    unitRef,
  });

const demandAt = (revision: number, quantity = '3') =>
  Schema.decodeUnknownSync(CatalogStockDemandSchema)({
    catalogSelection: selectionAt(revision),
    exactSelectionMeaning: meaningAt(revision),
    purchaseDemandOccurrenceId: `purchase-demand-set-${revision}`,
    quantity,
    unitRef,
  });

const resolverFor = (entries: readonly (readonly [CatalogToStockBinding, StockItem])[]) => {
  const bindings = new Map<string, CatalogToStockBinding>(
    entries.map(([binding]) => [binding.exactSelectionMeaning.id, binding]),
  );
  const stockItems = new Map<string, StockItem>(
    entries.map(([, stockItem]) => [stockItem.stockItemRef.resourceId, stockItem]),
  );
  const resolver = makeCatalogToStockBindingResolver(
    {
      findCurrentByExactSelectionMeaning: (_tenantId, meaning) =>
        Effect.succeed(Option.fromNullishOr(bindings.get(meaning.id)).pipe(Option.toArray)),
    },
    {
      findById: (_tenantId, stockItemId) => Effect.succeed(Option.fromNullishOr(stockItems.get(stockItemId))),
    },
  );
  return {
    resolve: (demand: ReturnType<typeof demandAt>) =>
      resolver.resolve(demand).pipe(Effect.flatMap(resolveFixedSetStockRequirement)),
  };
};

describe('fixed Set Stock Item binding', () => {
  it.effect('creates one exact Set requirement without decomposing Catalog component evidence', () =>
    Effect.gen(function* resolveFixedSet() {
      const stockItem = stockItemAt(1);
      const binding = bindingAt(1, stockItem);
      const demand = demandAt(1);
      const catalogComponentEvidence = ['component-A', 'component-B'] as const;

      const requirement = yield* resolverFor([[binding, stockItem]]).resolve(demand);

      expect(catalogComponentEvidence).toHaveLength(2);
      expect(requirement.stockItem).toEqual(stockItem);
      expect(requirement.quantity).toBe('3');
      expect(requirement.unitRef).toEqual(unitRef);
      expect(requirement.purchaseDemandOccurrenceId).toBe('purchase-demand-set-1');
      expect(requirement.setCompositionRevision).toEqual(selectionAt(1).setComposition);
      expect(requirement.stockRepresentation).toBe('ONE_EXACT_SET_STOCK_ITEM');
      expect(requirement.componentDecomposition).toBe('PROHIBITED');
      expect(requirement).not.toHaveProperty('componentStockRequirements');
      expect(JSON.stringify(requirement)).not.toContain('component-A');
      expect(JSON.stringify(requirement)).not.toContain('component-B');
    }),
  );

  it.effect('binds a material composition revision to a new Stock Item without rewriting historical evidence', () =>
    Effect.gen(function* preserveHistoricalMeaning() {
      const firstStockItem = stockItemAt(1);
      const secondStockItem = stockItemAt(2);
      const firstBinding = bindingAt(1, firstStockItem);
      const secondBinding = bindingAt(2, secondStockItem);
      const resolver = resolverFor([
        [firstBinding, firstStockItem],
        [secondBinding, secondStockItem],
      ]);

      const historical = yield* resolver.resolve(demandAt(1));
      const current = yield* resolver.resolve(demandAt(2));

      expect(current.stockItem.stockItemRef.resourceId).not.toBe(historical.stockItem.stockItemRef.resourceId);
      expect(current.exactSelectionMeaning).toEqual(meaningAt(2));
      expect(current.setCompositionRevision).toEqual(selectionAt(2).setComposition);
      expect(historical.stockItem).toEqual(firstStockItem);
      expect(historical.exactSelectionMeaning).toEqual(meaningAt(1));
      expect(historical.setCompositionRevision).toEqual(selectionAt(1).setComposition);
    }),
  );

  it.effect('rejects a resolved demand whose exact meaning is not a Set', () =>
    Effect.gen(function* rejectNonSetMeaning() {
      const stockItem = stockItemAt(1);
      const binding = bindingAt(1, stockItem);
      const resolved = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(stockItem)) },
      ).resolve(demandAt(1));
      const failure = yield* resolveFixedSetStockRequirement({
        ...resolved,
        exactSelectionMeaning: Schema.decodeUnknownSync(CatalogStockDemandSchema.fields.exactSelectionMeaning)({
          id: 'catalog-owner:plain-variant',
          kind: 'PRODUCT_VARIANT',
        }),
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(FixedSetStockItemBindingRejected);
      expect(failure.reason).toBe('EXACT_SELECTION_IS_NOT_A_SET');
    }),
  );

  it.effect('rejects a Set meaning without an exact Set Composition revision', () =>
    Effect.gen(function* rejectMissingComposition() {
      const stockItem = stockItemAt(1);
      const binding = bindingAt(1, stockItem);
      const resolved = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(stockItem)) },
      ).resolve(demandAt(1));
      const failure = yield* resolveFixedSetStockRequirement({
        ...resolved,
        catalogSelection: Schema.decodeUnknownSync(CatalogSelectionSchema)({
          productRef: resolved.catalogSelection.productRef,
          variantRef: resolved.catalogSelection.variantRef,
        }),
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(FixedSetStockItemBindingRejected);
      expect(failure.reason).toBe('SET_COMPOSITION_REVISION_MISSING');
    }),
  );
});
