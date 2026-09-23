import { Schema } from 'effect';

export class PriceGroupCatalogDatabaseConnectionError extends Schema.TaggedError<PriceGroupCatalogDatabaseConnectionError>()(
  'PriceGroupCatalogDatabaseConnectionError',
  { reason: Schema.String },
) {}
