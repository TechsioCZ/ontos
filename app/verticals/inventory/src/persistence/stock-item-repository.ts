import type { ReadServiceFactory } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { StockItemRejected, StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { ExactCatalogSelectionMeaningId, StockItem, StockItemInstant } from '../../shared/domain/stock-item.ts';
import { StockItemPersistenceUnavailable } from '../../shared/domain/stock-item-persistence-unavailable.ts';
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

const findCurrentByMeaning = (
  transaction: ScopedTransaction,
  tenantId: string,
  exactSelectionMeaningId: ExactCatalogSelectionMeaningId,
) =>
  transaction
    .select()
    .from(inventoryStockItems)
    .where(
      and(
        eq(inventoryStockItems.tenantId, tenantId),
        eq(inventoryStockItems.exactSelectionMeaningId, exactSelectionMeaningId),
        eq(inventoryStockItems.lifecycleState, 'CURRENT'),
      ),
    )
    .limit(1)
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : toDomain(row).pipe(Effect.asSome))),
    );

/** Insert attempts while a concurrent registration of the meaning keeps committing and retiring first. */
const MAX_REGISTRATION_INSERT_ATTEMPTS = 3;

const insertUnlessCurrent = (transaction: ScopedTransaction, item: StockItem) =>
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
    .onConflictDoNothing({
      target: [inventoryStockItems.tenantId, inventoryStockItems.exactSelectionMeaningId],
      where: sql`${sql.identifier(inventoryStockItems.lifecycleState.name)} = 'CURRENT'`,
    })
    .returning()
    .pipe(Effect.mapError(unavailable));

/**
 * Inserts `item` unless the meaning already has a Current Item, which it then refuses naming. The conflict
 * holds no lock on that Item, so a retirement can commit before it is read: with no Current Item left, the
 * insert runs again in the same transaction, at most `MAX_REGISTRATION_INSERT_ATTEMPTS` times in all.
 */
const insertCurrent = (
  transaction: ScopedTransaction,
  item: StockItem,
  remainingAttempts: number,
): Effect.Effect<StockItem, StockItemRepositoryError> =>
  insertUnlessCurrent(transaction, item).pipe(
    Effect.flatMap(([row]) =>
      row === undefined
        ? findCurrentByMeaning(transaction, item.stockItemRef.tenantId, item.exactSelectionMeaning.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  remainingAttempts > 1
                    ? insertCurrent(transaction, item, remainingAttempts - 1)
                    : Effect.fail(
                        unavailable(
                          'Stock Item registration kept losing to registrations retired before they were read',
                        ),
                      ),
                onSome: (existing) =>
                  Effect.fail(
                    new StockItemRejected({
                      code: 'stock_item_rejected',
                      exactSelectionMeaningId: existing.exactSelectionMeaning.id,
                      reason: 'exact_selection_meaning_already_registered',
                      stockItemId: existing.stockItemRef.resourceId,
                    }),
                  ),
              }),
            ),
          )
        : toDomain(row),
    ),
  );

export const makeDrizzleStockItemRepository = (transaction: ScopedTransaction): StockItemRepositoryService => ({
  findByExactSelectionMeaning: (tenantId, exactSelectionMeaningId) =>
    findCurrentByMeaning(transaction, tenantId, exactSelectionMeaningId),
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
  insert: (item) => insertCurrent(transaction, item, MAX_REGISTRATION_INSERT_ATTEMPTS),
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
        Effect.mapError(unavailable),
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

/** Owner composition binds this repository only to an already installed native operation transaction. */
export const stockItemRepositoryLayerForTransaction = (
  transaction: ScopedTransaction,
): Layer.Layer<StockItemRepository> => Layer.succeed(StockItemRepository, makeDrizzleStockItemRepository(transaction));
