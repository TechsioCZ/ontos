import { Schema } from 'effect';

export class SymmyJobPrivacyError extends Schema.TaggedError<SymmyJobPrivacyError>()('SymmyJobPrivacyError', {
  code: Schema.Literal('retention_privacy_unavailable'),
}) {}
