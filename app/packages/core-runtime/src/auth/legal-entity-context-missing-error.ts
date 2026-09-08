import { Schema } from 'effect';

export class LegalEntityContextMissingError extends Schema.TaggedError<LegalEntityContextMissingError>()(
  'LegalEntityContextMissingError',
  {}
) {}
