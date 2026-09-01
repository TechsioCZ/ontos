import { Schema } from 'effect';

export class ContactsDatabaseConnectionError extends Schema.TaggedError<ContactsDatabaseConnectionError>()(
  'ContactsDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
