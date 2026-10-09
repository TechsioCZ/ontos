import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CreateStockItemInputSchema,
  StockItemCompatibilityInputSchema,
  StockItemRejected,
  StockItemSchema,
} from '../../shared/domain/stock-item.ts';
import type { ExactCatalogSelectionKind, StockItem } from '../../shared/domain/stock-item.ts';
import { InventoryTenantIdSchema } from '../../shared/resources/stock-item.ts';
import { StockItemRepository } from '../../src/persistence/stock-item-repository.ts';
import type { StockItemRepositoryService } from '../../src/persistence/stock-item-repository.ts';
import { StockItemService, StockItemServiceLive } from '../../src/services/stock-item-service.ts';

const tenantId = Schema.decodeUnknownSync(InventoryTenantIdSchema)('11111111-1111-4111-8111-111111111111');
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const alternateUnitRef = {
  ...unitRef,
  resourceId: '66666666-6666-4666-8666-666666666666',
} as const;

const decodeCreate = Schema.decodeUnknownSync(CreateStockItemInputSchema);
const decodeCompatibility = Schema.decodeUnknownSync(StockItemCompatibilityInputSchema);
const decodeStockItem = Schema.decodeUnknownSync(StockItemSchema);

const makeRepository = Effect.gen(function* makeRepository() {
  const items = yield* Ref.make<ReadonlyMap<string, StockItem>>(new Map());

  return {
    findByExactSelectionMeaning: (requestedTenantId, exactSelectionMeaningId) =>
      Ref.get(items).pipe(
        Effect.map((stored) =>
          Option.fromNullishOr(
            [...stored.values()].find(
              (item) =>
                item.stockItemRef.tenantId === requestedTenantId &&
                item.exactSelectionMeaning.id === exactSelectionMeaningId,
            ),
          ),
        ),
      ),
    findById: (requestedTenantId, stockItemId) =>
      Ref.get(items).pipe(
        Effect.map((stored) => {
          const item = stored.get(stockItemId);
          return item?.stockItemRef.tenantId === requestedTenantId ? Option.some(item) : Option.none();
        }),
      ),
    insert: (item) =>
      Ref.modify(items, (stored) => [item, new Map(stored).set(item.stockItemRef.resourceId, item)] as const),
    retire: (item, retiredAt) =>
      Ref.modify(items, (stored) => {
        const retired = decodeStockItem({
          ...item,
          lifecycle: 'RETIRED',
          retiredAt,
          revision: item.revision + 1,
        });
        return [retired, new Map(stored).set(retired.stockItemRef.resourceId, retired)] as const;
      }),
  } satisfies StockItemRepositoryService;
});

const makeService = makeRepository.pipe(
  Effect.flatMap((repository) =>
    StockItemService.pipe(Effect.provide(StockItemServiceLive), Effect.provideService(StockItemRepository, repository)),
  ),
);

const selection = (kind: ExactCatalogSelectionKind, meaningId: string) =>
  decodeCreate({
    exactSelectionMeaning: { id: meaningId, kind },
    tenantId,
    unitRef,
  });
const packageSelection = (meaningId: string) => selection('PACKAGE_OPTION', meaningId);

describe('Stock Item identity and lifecycle', () => {
  it.effect('gives one exact Package Selection its own non-decomposed Stock Item', () =>
    Effect.gen(function* packageStockItem() {
      const repository = yield* makeRepository;
      const service = yield* StockItemService.pipe(
        Effect.provide(StockItemServiceLive),
        Effect.provideService(StockItemRepository, repository),
      );

      const item = yield* service.register(packageSelection('package-option:revision-1'));

      expect(item).toMatchObject({
        exactSelectionMeaning: { id: 'package-option:revision-1', kind: 'PACKAGE_OPTION' },
        lifecycle: 'CURRENT',
        stockItemRef: {
          moduleId: 'commerce.inventory',
          resourceId: expect.any(String),
          resourceType: 'commerce.inventory.stock-item',
          tenantId,
        },
        unitRef,
      });
      expect(item).not.toHaveProperty('componentStockItemIds');

      const duplicate = yield* service.register(packageSelection('package-option:revision-1')).pipe(Effect.flip);
      expect(duplicate).toBeInstanceOf(StockItemRejected);
      expect(duplicate).toMatchObject({ reason: 'exact_selection_meaning_already_registered' });
    }),
  );

  it.effect('requires a new Stock Item for a materially different exact Selection meaning', () =>
    Effect.gen(function* materialMeaningChange() {
      const service = yield* makeService;

      const revisionOne = yield* service.register(packageSelection('package-option:revision-1'));
      const revisionTwo = yield* service.register(packageSelection('package-option:revision-2'));

      expect(revisionOne.stockItemRef.resourceId).not.toBe(revisionTwo.stockItemRef.resourceId);
      expect(revisionOne.exactSelectionMeaning.id).toBe('package-option:revision-1');
    }),
  );

  it.effect('does not redefine Stock Item meaning during a binding correction', () =>
    Effect.gen(function* preserveIntrinsicMeaning() {
      const service = yield* makeService;
      const item = yield* service.register(packageSelection('selection:Sx'));

      const error = yield* service
        .assertCompatibleMeaning(
          item,
          decodeCompatibility({
            exactSelectionMeaning: { id: 'selection:S', kind: 'PACKAGE_OPTION' },
            unitRef,
          }),
        )
        .pipe(Effect.flip);

      expect(error).toMatchObject({ reason: 'exact_selection_meaning_mismatch' });
      expect(item.exactSelectionMeaning.id).toBe('selection:Sx');
    }),
  );

  it.effect('retirement blocks future Current use while preserving historical addressability', () =>
    Effect.gen(function* retiredHistory() {
      const service = yield* makeService;
      const item = yield* service.register(packageSelection('package-option:revision-1'));
      const retired = yield* service.retire(tenantId, item.stockItemRef.resourceId);

      const currentError = yield* service.requireCurrent(tenantId, item.stockItemRef.resourceId).pipe(Effect.flip);
      const historical = yield* service.getHistorical(tenantId, item.stockItemRef.resourceId);

      expect(currentError).toMatchObject({ reason: 'stock_item_retired' });
      expect(retired.lifecycle).toBe('RETIRED');
      expect(historical).toEqual(retired);
      expect(historical.exactSelectionMeaning).toEqual(item.exactSelectionMeaning);
    }),
  );

  it.effect('gives Set Variant and configured Selection meanings separate unique Stock Items', () =>
    Effect.gen(function* setAndConfiguredIdentities() {
      const service = yield* makeService;
      const setItem = yield* service.register(selection('SET_VARIANT', 'set-variant:revision-1'));
      const configuredItem = yield* service.register(
        selection('CONFIGURED_SELECTION', 'configured-selection:revision-1'),
      );

      expect(setItem.stockItemRef.resourceId).not.toBe(configuredItem.stockItemRef.resourceId);
      expect(setItem.exactSelectionMeaning.kind).toBe('SET_VARIANT');
      expect(configuredItem.exactSelectionMeaning.kind).toBe('CONFIGURED_SELECTION');
      expect(setItem).not.toHaveProperty('componentStockItemIds');
      expect(configuredItem).not.toHaveProperty('componentStockItemIds');

      for (const duplicateInput of [
        selection('SET_VARIANT', 'set-variant:revision-1'),
        selection('CONFIGURED_SELECTION', 'configured-selection:revision-1'),
      ]) {
        const duplicate = yield* service.register(duplicateInput).pipe(Effect.flip);
        expect(duplicate).toMatchObject({ reason: 'exact_selection_meaning_already_registered' });
      }
    }),
  );

  it.effect('preserves the explicit Unit and rejects conversion or incompatible reuse', () =>
    Effect.gen(function* preserveUnit() {
      const service = yield* makeService;
      const item = yield* service.register(packageSelection('package-option:revision-1'));

      const error = yield* service
        .assertCompatibleMeaning(
          item,
          decodeCompatibility({
            exactSelectionMeaning: item.exactSelectionMeaning,
            unitRef: alternateUnitRef,
          }),
        )
        .pipe(Effect.flip);

      expect(item.unitRef).toEqual(unitRef);
      expect(error).toMatchObject({ reason: 'stock_unit_mismatch' });
    }),
  );
});
