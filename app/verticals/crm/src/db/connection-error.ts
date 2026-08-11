import { Schema } from 'effect';

export class CrmDatabaseConnectionError extends Schema.TaggedErrorClass<CrmDatabaseConnectionError>()(
  'CrmDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
