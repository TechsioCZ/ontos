// Siampark provoz — agenda `purchasing` (S05 sklad a zásoby + S06 nákupní objednávky).
// OWNED BY THE `purchasing` LANE. Change freely; keep exporting PurchasingStateSchema and emptyPurchasingState.
// Old JSONB rows must still decode: add new fields as `Schema.optionalKey(...)` or reseed (pnpm demo:seed:siampark-ops).
import { Schema } from 'effect';
import { AuditFieldsSchema, NoteSchema, PropertyRefSchema, TextSchema, opsIdOf } from './common.ts';

export const StockItemIdSchema = opsIdOf('SiamparkStockItemId');
export type StockItemId = typeof StockItemIdSchema.Type;

export const StockItemSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: StockItemIdSchema,
  sku: TextSchema(64),
  name: TextSchema(200),
  unit: TextSchema(16),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type StockItem = typeof StockItemSchema.Type;

export const PurchasingStateSchema = Schema.Struct({
  items: Schema.Array(StockItemSchema),
});
export type PurchasingState = typeof PurchasingStateSchema.Type;
export type PurchasingStateEncoded = typeof PurchasingStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with PurchasingStateSchema. */
export const emptyPurchasingState: PurchasingStateEncoded = { items: [] };
