import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, exists, getTableColumns, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { createSelectSchema } from 'drizzle-orm/effect-schema';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Schema } from 'effect';

import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockLocationAddressEvidenceSchema } from '../../shared/domain/stock-location.ts';
import { StockSharingEligibilitySchema } from '../../shared/domain/stock-sharing-eligibility.ts';

import { RelevantStockPositionSetUnavailable } from '../../shared/domain/current-relevant-stock-position-set.ts';
import type { RelevantStockPositionSetScope } from '../../shared/domain/current-relevant-stock-position-set.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import {
  inventoryCatalogToStockBindings,
  inventoryCatalogToStockBindingHistory,
} from './catalog-to-stock-binding-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';
import {
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} from './stock-sharing-eligibility-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
export const positionSetUnavailable = (cause: unknown) => {
  const failure = new RelevantStockPositionSetUnavailable({
    code: 'relevant_stock_position_set_unavailable',
    reason: 'Inventory Position-set observation is unavailable',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { value: cause });
  return failure;
};

/** SQL exception: Drizzle has no ordered JSON row-aggregate builder. Typed owner columns
 * construct the JSON object; the table-derived schema decodes dates and domain JSON. Each
 * child is aggregated independently, so history growth never multiplies driver rows. */
const aggregateSnapshotRows = (
  transaction: ScopedTransaction,
  table: PgTable,
  identity: AnyPgColumn,
  predicate: SQL | undefined,
) => {
  const fields = Object.entries(getTableColumns(table)).flatMap(([name, column]) => [
    sql`${name}::text`,
    // JSON numbers would discard the native numeric column's exact decimal-string contract.
    column === inventoryStockPositions.onHandAmount ? sql`${column}::text` : sql`${column}`,
  ]);
  const separator = sql`, `;
  const child = transaction
    .select({
      rows: sql`jsonb_agg(jsonb_build_object(${sql.join(fields, separator)}) order by ${identity})`,
    })
    .from(table)
    .where(predicate);
  return sql<Schema.Json>`coalesce((${child}), '[]'::jsonb)`;
};

const backendSchema = createSelectSchema(inventoryBackendConfigurations, { selectedAt: Schema.DateFromString });
const bindingSchema = createSelectSchema(inventoryCatalogToStockBindings, {
  catalogSelection: CatalogSelectionSchema,
  effectiveFrom: Schema.DateFromString,
});
const bindingHistorySchema = createSelectSchema(inventoryCatalogToStockBindingHistory, {
  endedAt: Schema.DateFromString,
  recordedAt: Schema.DateFromString,
  snapshot: CatalogToStockBindingSchema,
  transition: Schema.Literals(['CORRECTED', 'ENDED', 'SUPERSEDED']),
});
const locationSchema = createSelectSchema(inventoryStockLocations, {
  addressEvidence: () => StockLocationAddressEvidenceSchema,
  createdAt: Schema.DateFromString,
  physicalSiteKeys: Schema.Array(Schema.String),
  transitionedAt: () => Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
const positionSchema = createSelectSchema(inventoryStockPositions, {
  createdAt: Schema.DateFromString,
  endedAt: () => Schema.DateFromString,
  onHandObservedAt: () => Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
const sharingSchema = createSelectSchema(inventoryStockSharingEligibilities, {
  commerceValidationObservedAt: Schema.DateFromString,
  createdAt: Schema.DateFromString,
  effectiveFrom: Schema.DateFromString,
  effectiveTo: () => Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
const sharingHistorySchema = createSelectSchema(inventoryStockSharingEligibilityHistory, {
  recordedAt: Schema.DateFromString,
  snapshot: StockSharingEligibilitySchema,
  transitionAt: Schema.DateFromString,
});

const snapshotRowsSchema = Schema.Struct({
  backendConfigurations: Schema.Array(backendSchema),
  bindingHistory: Schema.Array(bindingHistorySchema),
  bindings: Schema.Array(bindingSchema),
  locations: Schema.Array(locationSchema),
  positions: Schema.Array(positionSchema),
  sharing: Schema.Array(sharingSchema),
  sharingHistory: Schema.Array(sharingHistorySchema),
});

/** One typed SQL statement sees one PostgreSQL snapshot, including previously unknown
 * candidate Positions. No consumer-known ID list or per-row lock defines the set. Revalidation
 * reruns the same exact predicate. Ordered history aggregates prevent remove/recreate from
 * reviving proof without joining one-to-many relations into a cross product.
 */
export const observeRelevantStockPositionSet = (
  transaction: ScopedTransaction,
  operationScope: OperationalScope,
  requested: RelevantStockPositionSetScope,
) => {
  const positionPredicate = and(
    eq(inventoryStockPositions.tenantId, inventoryStockItems.tenantId),
    eq(inventoryStockPositions.stockItemId, inventoryStockItems.stockItemId),
    eq(inventoryStockPositions.customerConfigurationId, requested.customerConfigurationId),
  );
  const sharingPredicate = and(
    eq(inventoryStockSharingEligibilities.tenantId, inventoryStockItems.tenantId),
    exists(
      transaction
        .select({ id: inventoryStockPositions.stockPositionId })
        .from(inventoryStockPositions)
        .where(
          and(
            positionPredicate,
            eq(inventoryStockPositions.stockPositionId, inventoryStockSharingEligibilities.stockPositionId),
          ),
        ),
    ),
  );
  return transaction
    .select({
      backendConfigurations: aggregateSnapshotRows(
        transaction,
        inventoryBackendConfigurations,
        inventoryBackendConfigurations.configurationId,
        and(
          eq(inventoryBackendConfigurations.tenantId, inventoryStockItems.tenantId),
          eq(inventoryBackendConfigurations.customerConfigurationId, requested.customerConfigurationId),
        ),
      ),
      bindingHistory: aggregateSnapshotRows(
        transaction,
        inventoryCatalogToStockBindingHistory,
        inventoryCatalogToStockBindingHistory.bindingHistoryId,
        and(
          eq(inventoryCatalogToStockBindingHistory.tenantId, inventoryStockItems.tenantId),
          exists(
            transaction
              .select({ id: inventoryCatalogToStockBindings.bindingId })
              .from(inventoryCatalogToStockBindings)
              .where(
                and(
                  eq(inventoryCatalogToStockBindings.tenantId, inventoryStockItems.tenantId),
                  eq(inventoryCatalogToStockBindings.stockItemId, inventoryStockItems.stockItemId),
                  eq(inventoryCatalogToStockBindings.bindingId, inventoryCatalogToStockBindingHistory.bindingId),
                ),
              ),
          ),
        ),
      ),
      bindings: aggregateSnapshotRows(
        transaction,
        inventoryCatalogToStockBindings,
        inventoryCatalogToStockBindings.bindingId,
        and(
          eq(inventoryCatalogToStockBindings.tenantId, inventoryStockItems.tenantId),
          eq(inventoryCatalogToStockBindings.stockItemId, inventoryStockItems.stockItemId),
        ),
      ),
      item: inventoryStockItems,
      locations: aggregateSnapshotRows(
        transaction,
        inventoryStockLocations,
        inventoryStockLocations.stockLocationId,
        and(
          eq(inventoryStockLocations.tenantId, inventoryStockItems.tenantId),
          exists(
            transaction
              .select({ id: inventoryStockPositions.stockPositionId })
              .from(inventoryStockPositions)
              .where(
                and(
                  positionPredicate,
                  eq(inventoryStockPositions.stockLocationId, inventoryStockLocations.stockLocationId),
                ),
              ),
          ),
        ),
      ),
      // SQL exception: statement_timestamp has no Drizzle builder equivalent. It binds
      // observation to this same SELECT snapshot; the owner timestamp column decodes UTC Date.
      observedAt: sql<Date>`statement_timestamp()`.mapWith(inventoryStockItems.createdAt),
      positions: aggregateSnapshotRows(
        transaction,
        inventoryStockPositions,
        inventoryStockPositions.stockPositionId,
        positionPredicate,
      ),
      sharing: aggregateSnapshotRows(
        transaction,
        inventoryStockSharingEligibilities,
        inventoryStockSharingEligibilities.eligibilityId,
        sharingPredicate,
      ),
      sharingHistory: aggregateSnapshotRows(
        transaction,
        inventoryStockSharingEligibilityHistory,
        inventoryStockSharingEligibilityHistory.historyId,
        and(
          eq(inventoryStockSharingEligibilityHistory.tenantId, inventoryStockItems.tenantId),
          exists(
            transaction
              .select({ id: inventoryStockSharingEligibilities.eligibilityId })
              .from(inventoryStockSharingEligibilities)
              .where(
                and(
                  sharingPredicate,
                  eq(
                    inventoryStockSharingEligibilities.eligibilityId,
                    inventoryStockSharingEligibilityHistory.eligibilityId,
                  ),
                ),
              ),
          ),
        ),
      ),
    })
    .from(inventoryStockItems)
    .where(
      and(
        eq(inventoryStockItems.tenantId, operationScope.tenantId),
        eq(inventoryStockItems.stockItemId, requested.stockItemRef.resourceId),
      ),
    )
    .pipe(
      Effect.flatMap(([snapshot]) =>
        Schema.decodeUnknownEffect(snapshotRowsSchema)(
          snapshot ?? {
            backendConfigurations: [],
            bindingHistory: [],
            bindings: [],
            locations: [],
            positions: [],
            sharing: [],
            sharingHistory: [],
          },
        ).pipe(
          Effect.map((children) => ({
            ...children,
            items: snapshot === undefined ? [] : [snapshot.item],
            observedAt: snapshot?.observedAt,
          })),
        ),
      ),
      Effect.mapError(positionSetUnavailable),
    );
};

export type RelevantStockPositionSetObservation = Effect.Success<ReturnType<typeof observeRelevantStockPositionSet>>;
