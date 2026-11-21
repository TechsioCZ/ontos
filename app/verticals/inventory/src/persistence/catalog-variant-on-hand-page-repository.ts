import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { CatalogVariantStockItemSchema } from '../../shared/apis/catalog-variant-on-hand-page.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionPersistenceUnavailable } from '../../shared/domain/stock-position-persistence-unavailable.ts';
import { StockPositionRefSchema } from '../../shared/resources/stock-position.ts';
import { StockLocationRefSchema } from '../../shared/resources/stock-location.ts';
import { StockItemIdSchema } from '../../shared/resources/stock-item.ts';
import { inventoryCatalogToStockBindings } from './catalog-to-stock-binding-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const INVENTORY_MODULE_ID = 'commerce.inventory';

const bindingUnavailable = (cause: unknown) => {
  const failure = new CatalogToStockBindingUnavailable({
    code: 'catalog_to_stock_binding_unavailable',
    reason: 'Catalog-to-Stock Binding persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const positionUnavailable = (cause: unknown) => {
  const failure = new StockPositionPersistenceUnavailable({
    code: 'stock_position_persistence_unavailable',
    reason: 'Stock Position persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** One Current binding whose retained Catalog Selection names a requested Variant. */
export const CatalogVariantBindingSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  stockItem: CatalogVariantStockItemSchema,
});
export type CatalogVariantBinding = typeof CatalogVariantBindingSchema.Type;

/** One Current Stock Position of a bound Stock Item at an ACTIVE Stock Location, as the owner rows name it. */
export const CatalogVariantPositionRowSchema = Schema.Struct({
  positionRef: StockPositionRefSchema,
  stockItemId: StockItemIdSchema,
  stockLocation: Schema.Struct({ displayName: StockLocationSchema.fields.displayName, ref: StockLocationRefSchema }),
});
export type CatalogVariantPositionRow = typeof CatalogVariantPositionRowSchema.Type;

/** Owner-local reads of the Catalog Variant on-hand page, in the trusted Tenant's own transaction. */
export const catalogVariantOnHandPagePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
) => ({
  /**
   * Every Current binding whose Catalog Selection names one of the Variants, whatever Package, Set or configuration
   * it adds; the caller keeps those that select the Variant itself.
   */
  listBindings: Effect.fn('CatalogVariantOnHandPagePersistence.listBindings')(function* listBindings(
    variantIds: readonly string[],
  ) {
    const rows = yield* transaction
      .select()
      .from(inventoryCatalogToStockBindings)
      .where(
        and(
          eq(inventoryCatalogToStockBindings.tenantId, scope.tenantId),
          // SQL exception: Drizzle has no JSON path builder. The Variant is the one the retained Catalog Selection names.
          inArray(sql<string>`${inventoryCatalogToStockBindings.catalogSelection} -> 'variantRef' ->> 'resourceId'`, [
            ...variantIds,
          ]),
        ),
      )
      .orderBy(asc(inventoryCatalogToStockBindings.bindingId))
      .pipe(Effect.mapError(bindingUnavailable));
    return yield* Schema.decodeUnknownEffect(Schema.Array(CatalogVariantBindingSchema))(
      rows.map((row) => ({
        catalogSelection: row.catalogSelection,
        stockItem: {
          bindingRef: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: row.bindingId,
            resourceType: 'commerce.inventory.catalog-to-stock-binding',
            tenantId: row.tenantId,
          },
          exactSelectionMeaning: { id: row.exactSelectionMeaningId, kind: row.exactSelectionKind },
          stockItemRef: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: row.stockItemId,
            resourceType: 'commerce.inventory.stock-item',
            tenantId: row.tenantId,
          },
          unitRef: {
            moduleId: row.stockUnitModuleId,
            resourceId: row.stockUnitResourceId,
            resourceType: row.stockUnitResourceType,
            tenantId: row.stockUnitTenantId,
          },
        },
      })),
    ).pipe(Effect.mapError(bindingUnavailable));
  }),
  /**
   * The Current Positions of the Stock Items in the Customer Configuration under its selected backend configuration,
   * at ACTIVE Stock Locations, by Location name.
   */
  listPositions: Effect.fn('CatalogVariantOnHandPagePersistence.listPositions')(function* listPositions(input: {
    readonly configurationId: string;
    readonly customerConfigurationId: string;
    readonly stockItemIds: readonly string[];
  }) {
    const rows = yield* transaction
      .select({
        displayName: inventoryStockLocations.displayName,
        stockItemId: inventoryStockPositions.stockItemId,
        stockLocationId: inventoryStockPositions.stockLocationId,
        stockPositionId: inventoryStockPositions.stockPositionId,
      })
      .from(inventoryStockPositions)
      .innerJoin(
        inventoryStockLocations,
        and(
          eq(inventoryStockLocations.tenantId, inventoryStockPositions.tenantId),
          eq(inventoryStockLocations.stockLocationId, inventoryStockPositions.stockLocationId),
        ),
      )
      .where(
        and(
          eq(inventoryStockPositions.tenantId, scope.tenantId),
          eq(inventoryStockPositions.customerConfigurationId, input.customerConfigurationId),
          eq(inventoryStockPositions.ownerConfigurationId, input.configurationId),
          eq(inventoryStockPositions.lifecycleState, 'CURRENT'),
          eq(inventoryStockLocations.lifecycleState, 'ACTIVE'),
          inArray(inventoryStockPositions.stockItemId, [...input.stockItemIds]),
        ),
      )
      .orderBy(asc(inventoryStockLocations.displayName), asc(inventoryStockPositions.stockPositionId))
      .pipe(Effect.mapError(positionUnavailable));
    return yield* Schema.decodeUnknownEffect(Schema.Array(CatalogVariantPositionRowSchema))(
      rows.map((row) => ({
        positionRef: {
          moduleId: INVENTORY_MODULE_ID,
          resourceId: row.stockPositionId,
          resourceType: 'commerce.inventory.stock-position',
          tenantId: scope.tenantId,
        },
        stockItemId: row.stockItemId,
        stockLocation: {
          displayName: row.displayName,
          ref: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: row.stockLocationId,
            resourceType: 'commerce.inventory.stock-location',
            tenantId: scope.tenantId,
          },
        },
      })),
    ).pipe(Effect.mapError(positionUnavailable));
  }),
});
