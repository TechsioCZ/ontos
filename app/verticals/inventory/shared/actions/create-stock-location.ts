import { Schema } from 'effect';

import { StockLocationSchema } from '../domain/stock-location.ts';

export { StockLocationPersistenceUnavailable as CreateStockLocationErrorSchema } from '../domain/stock-location-persistence-unavailable.ts';

/** The operator-declared facts of one new ACTIVE Stock Location; Inventory assigns its identity. */
export const CreateStockLocationPayloadSchema = Schema.Struct({
  addressEvidence: StockLocationSchema.fields.addressEvidence,
  displayName: StockLocationSchema.fields.displayName,
  operationalScope: StockLocationSchema.fields.operationalScope,
});
export type CreateStockLocationPayload = typeof CreateStockLocationPayloadSchema.Type;

export const CreateStockLocationResultSchema = Schema.Struct({
  stockLocation: StockLocationSchema,
});
