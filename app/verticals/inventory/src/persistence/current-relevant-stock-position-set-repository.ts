import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';

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

const distinctRows = <Row extends object>(
  rows: readonly (Row | null)[],
  identity: (row: Row) => string,
): readonly Row[] => [
  ...new Map(rows.filter((row): row is Row => row !== null).map((row) => [identity(row), row])).values(),
];

/** One typed SQL statement sees one PostgreSQL snapshot, including previously unknown
 * candidate Positions. No consumer-known ID list or per-row lock defines the set. Revalidation
 * reruns the same exact predicate. History joins prevent remove/recreate from reviving proof.
 */
export const observeRelevantStockPositionSet = (
  transaction: ScopedTransaction,
  operationScope: OperationalScope,
  requested: RelevantStockPositionSetScope,
) =>
  transaction
    .select({
      backend: inventoryBackendConfigurations,
      binding: inventoryCatalogToStockBindings,
      bindingHistory: inventoryCatalogToStockBindingHistory,
      item: inventoryStockItems,
      location: inventoryStockLocations,
      // SQL exception: statement_timestamp has no Drizzle builder equivalent. It binds
      // observation to this same SELECT snapshot; the owner timestamp column decodes UTC Date.
      observedAt: sql<Date>`statement_timestamp()`.mapWith(inventoryStockItems.createdAt),
      position: inventoryStockPositions,
      sharing: inventoryStockSharingEligibilities,
      sharingHistory: inventoryStockSharingEligibilityHistory,
    })
    .from(inventoryStockItems)
    .leftJoin(
      inventoryBackendConfigurations,
      and(
        eq(inventoryBackendConfigurations.tenantId, inventoryStockItems.tenantId),
        eq(inventoryBackendConfigurations.customerConfigurationId, requested.customerConfigurationId),
      ),
    )
    .leftJoin(
      inventoryCatalogToStockBindings,
      and(
        eq(inventoryCatalogToStockBindings.tenantId, inventoryStockItems.tenantId),
        eq(inventoryCatalogToStockBindings.stockItemId, inventoryStockItems.stockItemId),
      ),
    )
    .leftJoin(
      inventoryStockPositions,
      and(
        eq(inventoryStockPositions.tenantId, inventoryStockItems.tenantId),
        eq(inventoryStockPositions.stockItemId, inventoryStockItems.stockItemId),
        eq(inventoryStockPositions.customerConfigurationId, requested.customerConfigurationId),
      ),
    )
    .leftJoin(
      inventoryStockLocations,
      and(
        eq(inventoryStockLocations.tenantId, inventoryStockPositions.tenantId),
        eq(inventoryStockLocations.stockLocationId, inventoryStockPositions.stockLocationId),
      ),
    )
    .leftJoin(
      inventoryStockSharingEligibilities,
      and(
        eq(inventoryStockSharingEligibilities.tenantId, inventoryStockPositions.tenantId),
        eq(inventoryStockSharingEligibilities.stockPositionId, inventoryStockPositions.stockPositionId),
      ),
    )
    .leftJoin(
      inventoryCatalogToStockBindingHistory,
      and(
        eq(inventoryCatalogToStockBindingHistory.tenantId, inventoryCatalogToStockBindings.tenantId),
        eq(inventoryCatalogToStockBindingHistory.bindingId, inventoryCatalogToStockBindings.bindingId),
      ),
    )
    .leftJoin(
      inventoryStockSharingEligibilityHistory,
      and(
        eq(inventoryStockSharingEligibilityHistory.tenantId, inventoryStockSharingEligibilities.tenantId),
        eq(inventoryStockSharingEligibilityHistory.eligibilityId, inventoryStockSharingEligibilities.eligibilityId),
      ),
    )
    .where(
      and(
        eq(inventoryStockItems.tenantId, operationScope.tenantId),
        eq(inventoryStockItems.stockItemId, requested.stockItemRef.resourceId),
      ),
    )
    .orderBy(
      asc(inventoryStockPositions.stockPositionId),
      asc(inventoryStockSharingEligibilities.eligibilityId),
      asc(inventoryCatalogToStockBindingHistory.bindingHistoryId),
      asc(inventoryStockSharingEligibilityHistory.historyId),
    )
    .pipe(
      Effect.mapError(positionSetUnavailable),
      Effect.map((rows) => ({
        backendConfigurations: distinctRows(
          rows.map((row) => row.backend),
          (row) => row.configurationId,
        ),
        bindingHistory: distinctRows(
          rows.map((row) => row.bindingHistory),
          (row) => row.bindingHistoryId,
        ),
        bindings: distinctRows(
          rows.map((row) => row.binding),
          (row) => row.bindingId,
        ),
        items: distinctRows(
          rows.map((row) => row.item),
          (row) => row.stockItemId,
        ),
        locations: distinctRows(
          rows.map((row) => row.location),
          (row) => row.stockLocationId,
        ),
        observedAt: rows[0]?.observedAt,
        positions: distinctRows(
          rows.map((row) => row.position),
          (row) => row.stockPositionId,
        ),
        sharing: distinctRows(
          rows.map((row) => row.sharing),
          (row) => row.eligibilityId,
        ),
        sharingHistory: distinctRows(
          rows.map((row) => row.sharingHistory),
          (row) => row.historyId,
        ),
      })),
    );

export type RelevantStockPositionSetObservation = Effect.Success<ReturnType<typeof observeRelevantStockPositionSet>>;
