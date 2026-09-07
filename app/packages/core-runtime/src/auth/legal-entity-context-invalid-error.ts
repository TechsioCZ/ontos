import { Schema } from 'effect';

export class LegalEntityContextInvalidError extends Schema.TaggedError<LegalEntityContextInvalidError>()(
  'LegalEntityContextInvalidError',
  {},
) {}
