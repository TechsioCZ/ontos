import { Schema } from 'effect';

export class TenantInactiveError extends Schema.TaggedError<TenantInactiveError>()(
  'TenantInactiveError',
  {}
) {}
