import { Schema } from 'effect';

export class CommerceMarketCatalogDatabaseConnectionError extends Schema.TaggedError<CommerceMarketCatalogDatabaseConnectionError>()(
  'CommerceMarketCatalogDatabaseConnectionError',
  { reason: Schema.String },
) {}
