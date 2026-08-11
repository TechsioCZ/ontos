import { Schema } from 'effect';

export class CrmDatabaseConfigError extends Schema.TaggedErrorClass<CrmDatabaseConfigError>()(
  'CrmDatabaseConfigError',
  {
    reason: Schema.String,
  },
) {}
