import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import { StockItemRejected, StockItemSchema } from '../../shared/domain/stock-item.ts';
import type {
  CreateStockItemInput,
  StockItem,
  StockItemCompatibilityInput,
  StockItemInstant,
} from '../../shared/domain/stock-item.ts';
import { StockItemRepository } from '../persistence/stock-item-repository.ts';
import type { StockItemPersistenceUnavailable } from '../persistence/stock-item-persistence-error.ts';

type StockItemServiceError = StockItemRejected | StockItemPersistenceUnavailable;

export interface StockItemServiceContract {
  readonly assertCompatibleMeaning: (
    item: StockItem,
    candidate: StockItemCompatibilityInput,
  ) => Effect.Effect<StockItem, StockItemRejected>;
  readonly getHistorical: (
    tenantId: StockItem['stockItemRef']['tenantId'],
    stockItemId: StockItem['stockItemRef']['resourceId'],
  ) => Effect.Effect<StockItem, StockItemServiceError>;
  readonly register: (input: CreateStockItemInput) => Effect.Effect<StockItem, StockItemServiceError>;
  readonly requireCurrent: (
    tenantId: StockItem['stockItemRef']['tenantId'],
    stockItemId: StockItem['stockItemRef']['resourceId'],
  ) => Effect.Effect<StockItem, StockItemServiceError>;
  readonly retire: (
    tenantId: StockItem['stockItemRef']['tenantId'],
    stockItemId: StockItem['stockItemRef']['resourceId'],
  ) => Effect.Effect<StockItem, StockItemServiceError>;
}

export class StockItemService extends Context.Service<StockItemService, StockItemServiceContract>()(
  '@app/inventory/services/stock-item-service/StockItemService',
) {}

const decodeStockItem = Schema.decodeUnknownEffect(StockItemSchema);

const notFound = (stockItemId: StockItem['stockItemRef']['resourceId']): StockItemRejected =>
  new StockItemRejected({ code: 'stock_item_rejected', reason: 'stock_item_not_found', stockItemId });

const makeStockItemService = Effect.gen(function* makeStockItemService() {
  const repository = yield* StockItemRepository;

  return {
    assertCompatibleMeaning: (item, candidate) => {
      if (
        item.exactSelectionMeaning.id !== candidate.exactSelectionMeaning.id ||
        item.exactSelectionMeaning.kind !== candidate.exactSelectionMeaning.kind
      ) {
        return Effect.fail(
          new StockItemRejected({
            code: 'stock_item_rejected',
            exactSelectionMeaningId: candidate.exactSelectionMeaning.id,
            reason: 'exact_selection_meaning_mismatch',
            stockItemId: item.stockItemRef.resourceId,
          }),
        );
      }
      return item.unitRef.moduleId === candidate.unitRef.moduleId &&
        item.unitRef.resourceId === candidate.unitRef.resourceId &&
        item.unitRef.resourceType === candidate.unitRef.resourceType &&
        item.unitRef.tenantId === candidate.unitRef.tenantId
        ? Effect.succeed(item)
        : Effect.fail(
            new StockItemRejected({
              code: 'stock_item_rejected',
              exactSelectionMeaningId: candidate.exactSelectionMeaning.id,
              reason: 'stock_unit_mismatch',
              stockItemId: item.stockItemRef.resourceId,
            }),
          );
    },
    getHistorical: (tenantId, stockItemId) =>
      repository
        .findById(tenantId, stockItemId)
        .pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(notFound(stockItemId)), onSome: Effect.succeed })),
        ),
    register: (input) =>
      repository.findByExactSelectionMeaning(input.tenantId, input.exactSelectionMeaning.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              DateTime.now.pipe(
                Effect.map(DateTime.formatIso),
                Effect.flatMap((createdAt) =>
                  decodeStockItem({
                    createdAt,
                    exactSelectionMeaning: input.exactSelectionMeaning,
                    lifecycle: 'CURRENT',
                    retiredAt: null,
                    revision: 1,
                    stockItemRef: {
                      moduleId: 'commerce.inventory',
                      resourceId: randomUUID(),
                      resourceType: 'commerce.inventory.stock-item',
                      tenantId: input.tenantId,
                    },
                    unitRef: input.unitRef,
                  }),
                ),
                Effect.orDie,
                Effect.flatMap(repository.insert),
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
      ),
    requireCurrent: (tenantId, stockItemId) =>
      repository.findById(tenantId, stockItemId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound(stockItemId)),
            onSome: (item) =>
              item.lifecycle === 'CURRENT'
                ? Effect.succeed(item)
                : Effect.fail(
                    new StockItemRejected({
                      code: 'stock_item_rejected',
                      reason: 'stock_item_retired',
                      stockItemId,
                    }),
                  ),
          }),
        ),
      ),
    retire: (tenantId, stockItemId) =>
      repository.findById(tenantId, stockItemId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound(stockItemId)),
            onSome: (item) =>
              item.lifecycle === 'RETIRED'
                ? Effect.succeed(item)
                : DateTime.now.pipe(
                    Effect.map(DateTime.formatIso),
                    Effect.flatMap((retiredAt: StockItemInstant) => repository.retire(item, retiredAt)),
                  ),
          }),
        ),
      ),
  } satisfies StockItemServiceContract;
});

export const StockItemServiceLive = Layer.effect(StockItemService, makeStockItemService);
