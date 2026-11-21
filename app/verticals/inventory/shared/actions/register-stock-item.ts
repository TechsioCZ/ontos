import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { Schema } from 'effect';

import { StockItemPersistenceUnavailable } from '../domain/stock-item-persistence-unavailable.ts';
import { ExactCatalogSelectionMeaningSchema, StockItemRejected, StockItemSchema } from '../domain/stock-item.ts';

/** The exact Catalog Selection meaning and Catalog Unit the new Stock Item carries; Inventory assigns its identity. */
export const RegisterStockItemPayloadSchema = Schema.Struct({
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  unitRef: ProductUnitRefSchema,
});
export type RegisterStockItemPayload = typeof RegisterStockItemPayloadSchema.Type;

export const RegisterStockItemResultSchema = Schema.Struct({
  stockItem: StockItemSchema,
});

export const RegisterStockItemErrorSchema = Schema.Union([StockItemRejected, StockItemPersistenceUnavailable]);
