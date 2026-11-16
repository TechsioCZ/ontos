import { Schema } from 'effect';

export class SymmyJobPrivacyExecutionError extends Schema.TaggedError<SymmyJobPrivacyExecutionError>()(
  'SymmyJobPrivacyExecutionError',
  { code: Schema.Literals(['privacy_execution_unavailable', 'privacy_execution_conflict']) },
) {}
