import { Schema } from 'effect';

export const ProductCommercialFeeBulkRejectionCodeSchema = Schema.Literals([
  'BULK_SCOPE_MISMATCH',
  'BULK_SNAPSHOT_INVALID',
  'BULK_CURRENCY_NOT_ENABLED',
  'BULK_TARGET_IDENTITY_MISMATCH',
  'BULK_TARGET_SET_MISMATCH',
]);
export type ProductCommercialFeeBulkRejectionCode = typeof ProductCommercialFeeBulkRejectionCodeSchema.Type;

export class ProductCommercialFeeBulkRejected extends Schema.TaggedError<ProductCommercialFeeBulkRejected>()(
  'ProductCommercialFeeBulkRejected',
  {
    code: ProductCommercialFeeBulkRejectionCodeSchema,
    reason: Schema.String,
  },
) {}

export { ProductCommercialFeeBulkUnavailable } from './product-commercial-fee-bulk-unavailable.ts';
