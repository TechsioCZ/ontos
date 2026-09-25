import { findPostgresFailure } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Schema } from 'effect';

import { StockItemRejected, StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { ExactCatalogSelectionMeaningId, StockItem, StockItemInstant } from '../../shared/domain/stock-item.ts';
import { StockItemPersistenceUnavailable } from './stock-item-persistence-error.ts';
import { inventoryStockItems } from './stock-item-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

type StockItemRepositoryError = StockItemRejected | StockItemPersistenceUnavailable;

export interface StockItemRepositoryService {
  readonly findByExactSelectionMeaning: (
    tenantId: string,
    exactSelectionMeaningId: ExactCatalogSelectionMeaningId,
  ) => Effect.Effect<Option.Option<StockItem>, StockItemPersistenceUnavailable>;
  readonly findById: (
    tenantId: string,
    stockItemId: string,
  ) => Effect.Effect<Option.Option<StockItem>, StockItemPersistenceUnavailable>;
  readonly insert: (item: StockItem) => Effect.Effect<StockItem, StockItemRepositoryError>;
  readonly retire: (item: StockItem, retiredAt: StockItemInstant) => Effect.Effect<StockItem, StockItemRepositoryError>;
}

export class StockItemRepository extends Context.Service<StockItemRepository, StockItemRepositoryService>()(
  '@app/inventory/persistence/stock-item-repository/StockItemRepository',
) {}

const unavailable = (cause?: unknown): StockItemPersistenceUnavailable => {
  const failure = new StockItemPersistenceUnavailable({
    code: 'stock_item_persistence_unavailable',
    reason: 'Stock Item persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const uniqueViolationSqlState = ['23', '505'].join('');

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The SQL driver cause is opaque until Core's approved PostgreSQL decoder parses it.
export const mapStockItemWriteError = (error: unknown): StockItemRepositoryError =>
  Option.isSome(
    findPostgresFailure(
      error,
      ({ code, constraint }) =>
        code === uniqueViolationSqlState && constraint === 'inventory_stock_items_exact_meaning_uk',
    ),
  )
    ? new StockItemRejected({
        code: 'stock_item_rejected',
        reason: 'exact_selection_meaning_already_registered',
      })
    : unavailable(error);

const decodeStockItem = Schema.decodeUnknownEffect(StockItemSchema);
const instantAsDate = (instant: StockItemInstant): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const toDomain = (row: typeof inventoryStockItems.$inferSelect) =>
  decodeStockItem({
    createdAt: row.createdAt.toISOString(),
    exactSelectionMeaning: {
      id: row.exactSelectionMeaningId,
      kind: row.exactSelectionKind,
    },
    lifecycle: row.lifecycleState,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    revision: row.revision,
    stockItemRef: {
      moduleId: 'commerce.inventory',
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
  }).pipe(Effect.mapError(unavailable));

export const makeDrizzleStockItemRepository = (transaction: ScopedTransaction): StockItemRepositoryService => ({
  findByExactSelectionMeaning: (tenantId, exactSelectionMeaningId) =>
    transaction
      .select()
      .from(inventoryStockItems)
      .where(
        and(
          eq(inventoryStockItems.tenantId, tenantId),
          eq(inventoryStockItems.exactSelectionMeaningId, exactSelectionMeaningId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : toDomain(row).pipe(Effect.asSome))),
      ),
  findById: (tenantId, stockItemId) =>
    transaction
      .select()
      .from(inventoryStockItems)
      .where(and(eq(inventoryStockItems.tenantId, tenantId), eq(inventoryStockItems.stockItemId, stockItemId)))
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : toDomain(row).pipe(Effect.asSome))),
      ),
  insert: (item) =>
    transaction
      .insert(inventoryStockItems)
      .values({
        createdAt: instantAsDate(item.createdAt),
        exactSelectionKind: item.exactSelectionMeaning.kind,
        exactSelectionMeaningId: item.exactSelectionMeaning.id,
        lifecycleState: item.lifecycle,
        retiredAt: item.retiredAt === null ? null : instantAsDate(item.retiredAt),
        revision: item.revision,
        stockItemId: item.stockItemRef.resourceId,
        stockUnitModuleId: item.unitRef.moduleId,
        stockUnitResourceId: item.unitRef.resourceId,
        stockUnitResourceType: item.unitRef.resourceType,
        stockUnitTenantId: item.unitRef.tenantId,
        tenantId: item.stockItemRef.tenantId,
      })
      .returning()
      .pipe(
        Effect.mapError(mapStockItemWriteError),
        Effect.flatMap(([row]) => (row === undefined ? Effect.fail(unavailable()) : toDomain(row))),
      ),
  retire: (item, retiredAt) =>
    transaction
      .update(inventoryStockItems)
      .set({ lifecycleState: 'RETIRED', retiredAt: instantAsDate(retiredAt), revision: item.revision + 1 })
      .where(
        and(
          eq(inventoryStockItems.tenantId, item.stockItemRef.tenantId),
          eq(inventoryStockItems.stockItemId, item.stockItemRef.resourceId),
          eq(inventoryStockItems.lifecycleState, 'CURRENT'),
          eq(inventoryStockItems.revision, item.revision),
        ),
      )
      .returning()
      .pipe(
        Effect.mapError(mapStockItemWriteError),
        Effect.flatMap(([row]): Effect.Effect<StockItem, StockItemRepositoryError> =>
          row === undefined
            ? Effect.fail(
                new StockItemRejected({
                  code: 'stock_item_rejected',
                  reason: 'stock_item_retired',
                  stockItemId: item.stockItemRef.resourceId,
                }),
              )
            : toDomain(row),
        ),
      ),
});
