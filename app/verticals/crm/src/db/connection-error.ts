import { Schema } from 'effect';

export class CrmDatabaseConnectionError extends Schema.TaggedError<CrmDatabaseConnectionError>()(
  'CrmDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
