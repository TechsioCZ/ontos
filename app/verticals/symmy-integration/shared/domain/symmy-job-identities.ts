import { Schema } from 'effect';

export const SymmyJobIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyJobId'));

/** The five durable POST routes; synchronous Group/Stock and reads never create jobs. */
export const SymmyDurableJobRouteKeySchema = Schema.Literals([
  'customerGroupCustomersBatch',
  'customersBatch',
  'priceListPricesBatch',
  'priceListsBatchUpsert',
  'productsBatch',
]);
