import { Schema } from 'effect';

export class PaymentTermCatalogDatabaseConnectionError extends Schema.TaggedError<PaymentTermCatalogDatabaseConnectionError>()(
  'PaymentTermCatalogDatabaseConnectionError',
  { reason: Schema.String },
) {}
