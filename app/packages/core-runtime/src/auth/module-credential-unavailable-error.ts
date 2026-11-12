import { Schema } from 'effect';

/** The platform's module credential enrolment could not be read or written; callers fail closed. */
export class ModuleCredentialUnavailableError extends Schema.TaggedError<ModuleCredentialUnavailableError>()(
  'ModuleCredentialUnavailableError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}
