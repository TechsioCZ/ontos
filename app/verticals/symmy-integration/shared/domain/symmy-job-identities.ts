import { Schema } from 'effect';

export const SymmyJobIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyJobId'));

/** Durable POST routes, including operator fixture routes. */
export const SymmyDurableJobRouteKeySchema = Schema.Literals([
  'customerGroupCustomersBatch',
  'customersBatch',
  'priceListPricesBatch',
  'priceListsBatchUpsert',
  'productsBatch',
  'assortmentRulesFixtureBatch',
  'sellerVatDeclarationsFixtureBatch',
]);

/** Both job routes can carry personal data; the pinned intents determine which Privacy checks apply. */
export const isSymmyCustomerIntakeRoute = Schema.is(Schema.Literals(['customersBatch', 'customerGroupCustomersBatch']));
