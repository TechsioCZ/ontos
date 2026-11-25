import { Schema } from 'effect';

import { InventoryBackendConfigurationPersistenceUnavailable } from '../domain/inventory-backend-configuration-persistence-unavailable.ts';
import { StockPositionPersistenceUnavailable } from '../domain/stock-position-persistence-unavailable.ts';
import { StockPositionRejected, StockPositionSchema, StockPositionScopeSchema } from '../domain/stock-position.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';

/**
 * One Current Stock Position for an exact Item, Location, Unit and Customer Configuration. Its ON_HAND starts
 * UNKNOWN under the named selected Inventory Backend configuration; a quantity only ever arrives later as owner
 * evidence, never through this payload.
 */
export const EstablishStockPositionPayloadSchema = Schema.Struct({
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  scope: StockPositionScopeSchema,
}).check(
  Schema.makeFilter(({ ownerConfigurationRef, scope }) =>
    String(ownerConfigurationRef.tenantId) === String(scope.stockItemRef.tenantId)
      ? undefined
      : 'The owner configuration and the Stock Position scope must share one Tenant',
  ),
);
export type EstablishStockPositionPayload = typeof EstablishStockPositionPayloadSchema.Type;

export const EstablishStockPositionResultSchema = Schema.Struct({
  stockPosition: StockPositionSchema,
});

export const EstablishStockPositionErrorSchema = Schema.Union([
  StockPositionRejected,
  StockPositionPersistenceUnavailable,
  InventoryBackendConfigurationPersistenceUnavailable,
]);
