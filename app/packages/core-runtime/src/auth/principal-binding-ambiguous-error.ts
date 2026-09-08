import { Schema } from 'effect';

export class PrincipalBindingAmbiguousError extends Schema.TaggedError<PrincipalBindingAmbiguousError>()(
  'PrincipalBindingAmbiguousError',
  {},
) {}
