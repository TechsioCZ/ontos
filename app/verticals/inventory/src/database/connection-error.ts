import { Schema } from 'effect';

export class InventoryDatabaseConnectionError extends Schema.TaggedError<InventoryDatabaseConnectionError>()(
  'InventoryDatabaseConnectionError',
  { reason: Schema.String },
) {}
