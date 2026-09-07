import { Schema } from 'effect';

export class PrincipalBindingInactiveError extends Schema.TaggedError<PrincipalBindingInactiveError>()(
  'PrincipalBindingInactiveError',
  {},
) {}
