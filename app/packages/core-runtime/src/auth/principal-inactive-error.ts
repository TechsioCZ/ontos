import { Schema } from 'effect';

export class PrincipalInactiveError extends Schema.TaggedError<PrincipalInactiveError>()(
  'PrincipalInactiveError',
  {},
) {}
