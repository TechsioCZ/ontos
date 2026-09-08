import { Schema } from 'effect';

export class LegalEntityContextInactiveError extends Schema.TaggedError<LegalEntityContextInactiveError>()(
  'LegalEntityContextInactiveError',
  {},
) {}
