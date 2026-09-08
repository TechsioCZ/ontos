import { Schema } from 'effect';

export class LegalEntityContextAmbiguousError extends Schema.TaggedError<LegalEntityContextAmbiguousError>()(
  'LegalEntityContextAmbiguousError',
  {}
) {}
