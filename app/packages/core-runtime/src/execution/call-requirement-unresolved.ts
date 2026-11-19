import { Schema } from 'effect';

/**
 * A declared call's requirement could not be resolved in the executing operation's lease. The call
 * executor answers it as `Unavailable`; it never reaches module code.
 */
export class CallRequirementUnresolved extends Schema.TaggedError<CallRequirementUnresolved>()(
  'CallRequirementUnresolved',
  {
    reason: Schema.Literals(['lease_mismatch', 'not_declared', 'provider_mismatch', 'provider_not_installed']),
  },
) {}
