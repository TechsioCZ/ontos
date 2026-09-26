import { findPostgresFailure } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  CatalogToStockBindingHistoryEntrySchema,
  CatalogToStockBindingRejected,
  CatalogToStockBindingSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingPersistence,
  CatalogToStockBindingStockItemReader,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CatalogToStockBindingRef } from '../../shared/resources/catalog-to-stock-binding.ts';
import {
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindingCompatibilityTriggerContract,
  inventoryCatalogToStockBindings,
} from './catalog-to-stock-binding-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import type { StockItemRepositoryService } from './stock-item-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type BindingRow = typeof inventoryCatalogToStockBindings.$inferSelect;
type StockItemTargetRow = typeof inventoryStockItems.$inferSelect;

const unavailable = (cause?: unknown): CatalogToStockBindingUnavailable => {
  const failure = new CatalogToStockBindingUnavailable({
    code: 'catalog_to_stock_binding_unavailable',
    reason: 'Catalog-to-Stock Binding persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const reject = (reason: CatalogToStockBindingRejected['reason']) =>
  new CatalogToStockBindingRejected({ code: 'catalog_to_stock_binding_rejected', reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const checkViolationSqlState = ['23', '514'].join('');

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core's PostgreSQL decoder owns inspection of the opaque driver cause.
export const mapCatalogToStockBindingWriteError = (error: unknown) => {
  const { failureConstraints } = inventoryCatalogToStockBindingCompatibilityTriggerContract;
  const targetFailure = findPostgresFailure(error, ({ code, constraint }) => {
    if (code === foreignKeyViolationSqlState && constraint === 'inventory_catalog_to_stock_bindings_stock_item_fk') {
      return true;
    }
    return code === checkViolationSqlState && Object.values(failureConstraints).some((owned) => owned === constraint);
  });
  if (Option.isSome(targetFailure)) {
    const { constraint } = targetFailure.value;
    if (constraint === failureConstraints.current) {
      return reject('STOCK_ITEM_NOT_CURRENT');
    }
    if (constraint === failureConstraints.meaning || constraint === failureConstraints.stockItemMutation) {
      return reject('INTRINSIC_MEANING_MISMATCH');
    }
    if (constraint === failureConstraints.unit) {
      return reject('STOCK_UNIT_MISMATCH');
    }
    return reject('STOCK_ITEM_NOT_FOUND');
  }
  const selectionConflict = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_catalog_to_stock_bindings_selection_meaning_uk',
  );
  if (Option.isSome(selectionConflict)) {
    return reject('SELECTION_MEANING_ALREADY_BOUND');
  }
  const targetConflict = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_catalog_to_stock_bindings_stock_item_uk',
  );
  if (Option.isSome(targetConflict)) {
    return reject('STOCK_ITEM_ALREADY_BOUND');
  }
  const bindingIdentityConflict = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      ['catalog_to_stock_bindings_pkey', 'inventory_catalog_to_stock_bindings_scope_id_uk'].includes(constraint ?? ''),
  );
  if (Option.isSome(bindingIdentityConflict)) {
    return reject('BINDING_ID_CONFLICT');
  }
  const historyConflict = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_catalog_to_stock_binding_history_revision_uk',
  );
  return Option.isSome(historyConflict) ? reject('REVISION_CONFLICT') : unavailable(error);
};

const instantAsDate = (instant: CatalogToStockBinding['effectiveFrom']) =>
  DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const bindingValues = (binding: CatalogToStockBinding) => ({
  bindingId: binding.bindingRef.resourceId,
  catalogSelection: binding.catalogSelection,
  currentRevision: binding.revision,
  effectiveFrom: instantAsDate(binding.effectiveFrom),
  exactSelectionKind: binding.exactSelectionMeaning.kind,
  exactSelectionMeaningId: binding.exactSelectionMeaning.id,
  stockItemId: binding.stockItemRef.resourceId,
  stockUnitModuleId: binding.unitRef.moduleId,
  stockUnitResourceId: binding.unitRef.resourceId,
  stockUnitResourceType: binding.unitRef.resourceType,
  stockUnitTenantId: binding.unitRef.tenantId,
  tenantId: binding.bindingRef.tenantId,
});

const bindingReplacementValues = (binding: CatalogToStockBinding) => ({
  currentRevision: binding.revision,
  effectiveFrom: instantAsDate(binding.effectiveFrom),
  exactSelectionKind: binding.exactSelectionMeaning.kind,
  exactSelectionMeaningId: binding.exactSelectionMeaning.id,
  stockItemId: binding.stockItemRef.resourceId,
  stockUnitModuleId: binding.unitRef.moduleId,
  stockUnitResourceId: binding.unitRef.resourceId,
  stockUnitResourceType: binding.unitRef.resourceType,
  stockUnitTenantId: binding.unitRef.tenantId,
});

export const validateCatalogToStockBindingTarget = (
  binding: CatalogToStockBinding,
  target: StockItemTargetRow | undefined,
) => {
  if (target === undefined) {
    return Effect.fail(reject('STOCK_ITEM_NOT_FOUND'));
  }
  if (target.lifecycleState !== 'CURRENT') {
    return Effect.fail(reject('STOCK_ITEM_NOT_CURRENT'));
  }
  if (
    target.exactSelectionMeaningId !== binding.exactSelectionMeaning.id ||
    target.exactSelectionKind !== binding.exactSelectionMeaning.kind
  ) {
    return Effect.fail(reject('INTRINSIC_MEANING_MISMATCH'));
  }
  return target.stockUnitModuleId === binding.unitRef.moduleId &&
    target.stockUnitResourceId === binding.unitRef.resourceId &&
    target.stockUnitResourceType === binding.unitRef.resourceType &&
    target.stockUnitTenantId === binding.unitRef.tenantId
    ? Effect.succeed(binding)
    : Effect.fail(reject('STOCK_UNIT_MISMATCH'));
};

const decodeBinding = (row: BindingRow) =>
  Schema.decodeUnknownEffect(CatalogToStockBindingSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: row.bindingId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId: row.tenantId,
    },
    catalogSelection: row.catalogSelection,
    effectiveFrom: row.effectiveFrom.toISOString(),
    exactSelectionMeaning: { id: row.exactSelectionMeaningId, kind: row.exactSelectionKind },
    revision: row.currentRevision,
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

export const catalogToStockBindingStockItemReader = (
  stockItems: Pick<StockItemRepositoryService, 'findById'>,
): CatalogToStockBindingStockItemReader => ({
  findById: (tenantId, stockItemId) => stockItems.findById(tenantId, stockItemId).pipe(Effect.mapError(unavailable)),
});

export const makeDrizzleCatalogToStockBindingPersistence = (
  transaction: ScopedTransaction,
): CatalogToStockBindingPersistence => {
  const assertPersistableTarget = (binding: CatalogToStockBinding) =>
    transaction
      .select()
      .from(inventoryStockItems)
      .where(
        and(
          eq(inventoryStockItems.tenantId, binding.stockItemRef.tenantId),
          eq(inventoryStockItems.stockItemId, binding.stockItemRef.resourceId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(([target]) => validateCatalogToStockBindingTarget(binding, target)),
      );

  const replaceCurrent: CatalogToStockBindingPersistence['replaceCurrent'] = Effect.fn(
    'CatalogToStockBindingPersistence.replaceCurrent',
  )(function* replaceBinding({ current, historyEntry, next }) {
    yield* assertPersistableTarget(next);
    yield* transaction
      .insert(inventoryCatalogToStockBindingHistory)
      .values({
        bindingId: current.bindingRef.resourceId,
        endedAt: instantAsDate(historyEntry.endedAt),
        ownerEvidenceRef: historyEntry.ownerEvidenceRef,
        revision: current.revision,
        snapshot: current,
        tenantId: current.bindingRef.tenantId,
        transition: historyEntry.transition,
      })
      .pipe(Effect.mapError(mapCatalogToStockBindingWriteError));

    const [row] = yield* transaction
      .update(inventoryCatalogToStockBindings)
      .set(bindingReplacementValues(next))
      .where(
        and(
          eq(inventoryCatalogToStockBindings.tenantId, current.bindingRef.tenantId),
          eq(inventoryCatalogToStockBindings.bindingId, current.bindingRef.resourceId),
          eq(inventoryCatalogToStockBindings.currentRevision, current.revision),
          eq(inventoryCatalogToStockBindings.stockItemId, current.stockItemRef.resourceId),
        ),
      )
      .returning()
      .pipe(Effect.mapError(mapCatalogToStockBindingWriteError));

    if (row === undefined) {
      return yield* reject('REVISION_CONFLICT');
    }
    return yield* decodeBinding(row);
  });

  const endCurrent: CatalogToStockBindingPersistence['endCurrent'] = Effect.fn(
    'CatalogToStockBindingPersistence.endCurrent',
  )(function* endBinding({ current, historyEntry }) {
    yield* transaction
      .insert(inventoryCatalogToStockBindingHistory)
      .values({
        bindingId: current.bindingRef.resourceId,
        endedAt: instantAsDate(historyEntry.endedAt),
        ownerEvidenceRef: historyEntry.ownerEvidenceRef,
        revision: current.revision,
        snapshot: current,
        tenantId: current.bindingRef.tenantId,
        transition: historyEntry.transition,
      })
      .pipe(Effect.mapError(mapCatalogToStockBindingWriteError));

    const [removed] = yield* transaction
      .delete(inventoryCatalogToStockBindings)
      .where(
        and(
          eq(inventoryCatalogToStockBindings.tenantId, current.bindingRef.tenantId),
          eq(inventoryCatalogToStockBindings.bindingId, current.bindingRef.resourceId),
          eq(inventoryCatalogToStockBindings.currentRevision, current.revision),
          eq(inventoryCatalogToStockBindings.stockItemId, current.stockItemRef.resourceId),
        ),
      )
      .returning({ bindingId: inventoryCatalogToStockBindings.bindingId })
      .pipe(Effect.mapError(mapCatalogToStockBindingWriteError));

    if (removed === undefined) {
      return yield* reject('REVISION_CONFLICT');
    }
    return historyEntry;
  });

  return {
    endCurrent,
    findCurrentByExactSelectionMeaning: (tenantId, exactSelectionMeaning) =>
      transaction
        .select()
        .from(inventoryCatalogToStockBindings)
        .where(
          and(
            eq(inventoryCatalogToStockBindings.tenantId, tenantId),
            eq(inventoryCatalogToStockBindings.exactSelectionMeaningId, exactSelectionMeaning.id),
          ),
        )
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeBinding(row), { concurrency: 1 })),
        ),
    findCurrentByStockItem: (stockItemRef) =>
      transaction
        .select()
        .from(inventoryCatalogToStockBindings)
        .where(
          and(
            eq(inventoryCatalogToStockBindings.tenantId, stockItemRef.tenantId),
            eq(inventoryCatalogToStockBindings.stockItemId, stockItemRef.resourceId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeBinding(row).pipe(Effect.asSome))),
        ),
    insertCurrent: (binding) =>
      assertPersistableTarget(binding).pipe(
        Effect.flatMap(() =>
          transaction
            .insert(inventoryCatalogToStockBindings)
            .values(bindingValues(binding))
            .returning()
            .pipe(
              Effect.mapError(mapCatalogToStockBindingWriteError),
              Effect.flatMap(([row]) => (row === undefined ? Effect.fail(unavailable()) : decodeBinding(row))),
            ),
        ),
      ),
    readHistory: (bindingRef: CatalogToStockBindingRef) =>
      transaction
        .select()
        .from(inventoryCatalogToStockBindingHistory)
        .where(
          and(
            eq(inventoryCatalogToStockBindingHistory.tenantId, bindingRef.tenantId),
            eq(inventoryCatalogToStockBindingHistory.bindingId, bindingRef.resourceId),
          ),
        )
        .orderBy(asc(inventoryCatalogToStockBindingHistory.revision))
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) =>
                Schema.decodeEffect(CatalogToStockBindingHistoryEntrySchema)({
                  binding: row.snapshot,
                  endedAt: row.endedAt.toISOString(),
                  ownerEvidenceRef: row.ownerEvidenceRef,
                  transition: row.transition,
                }).pipe(Effect.mapError(unavailable)),
              { concurrency: 1 },
            ),
          ),
        ),
    replaceCurrent,
  };
};
