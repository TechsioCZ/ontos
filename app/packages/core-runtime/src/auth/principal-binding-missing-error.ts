import { Schema } from 'effect';

export class PrincipalBindingMissingError extends Schema.TaggedError<PrincipalBindingMissingError>()(
  'PrincipalBindingMissingError',
  {}
) {}
