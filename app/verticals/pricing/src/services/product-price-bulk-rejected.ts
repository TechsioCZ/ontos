import { Schema } from 'effect';

export const ProductPriceBulkRejectionCodeSchema = Schema.Literals([
  'BULK_SCOPE_MISMATCH',
  'BULK_SNAPSHOT_INVALID',
  'BULK_TARGET_IDENTITY_MISMATCH',
  'BULK_TARGET_SET_MISMATCH',
]);
export type ProductPriceBulkRejectionCode = typeof ProductPriceBulkRejectionCodeSchema.Type;

export class ProductPriceBulkRejected extends Schema.TaggedError<ProductPriceBulkRejected>()(
  'ProductPriceBulkRejected',
  {
    code: ProductPriceBulkRejectionCodeSchema,
    reason: Schema.String,
  },
) {}
