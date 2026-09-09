import { Schema } from 'effect';

export class PrincipalResolverUnavailableError extends Schema.TaggedError<PrincipalResolverUnavailableError>()(
  'PrincipalResolverUnavailableError',
  { reason: Schema.String },
) {}
