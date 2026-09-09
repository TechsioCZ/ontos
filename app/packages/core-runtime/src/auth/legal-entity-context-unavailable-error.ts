import { Schema } from 'effect';

export class LegalEntityContextUnavailableError extends Schema.TaggedError<LegalEntityContextUnavailableError>()(
  'LegalEntityContextUnavailableError',
  { reason: Schema.String },
) {}
