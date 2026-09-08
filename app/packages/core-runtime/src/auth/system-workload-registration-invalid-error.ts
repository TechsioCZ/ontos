import { Schema } from 'effect';

export class SystemWorkloadRegistrationInvalidError extends Schema.TaggedError<SystemWorkloadRegistrationInvalidError>()(
  'SystemWorkloadRegistrationInvalidError',
  {
    code: Schema.Literal('system_workload_registration_invalid'),
    message: Schema.String,
  }
) {}
