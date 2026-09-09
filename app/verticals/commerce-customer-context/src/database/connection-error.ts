import { Schema } from 'effect';

export class CommerceCustomerContextDatabaseConnectionError extends Schema.TaggedError<CommerceCustomerContextDatabaseConnectionError>()(
  'CommerceCustomerContextDatabaseConnectionError',
  { reason: Schema.String },
) {}
