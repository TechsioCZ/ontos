import { Schema } from 'effect';

/**
 * Expected failure: the supported Privacy path that binds subject, exact purpose and version, operation, Tenant and Legal
 * Entity BEFORE the address is verified does not exist. The message stops as `not-sent` with this distinct reason.
 */
export class PreVerificationPrivacyBindingUnavailable extends Schema.TaggedError<PreVerificationPrivacyBindingUnavailable>()(
  'PreVerificationPrivacyBindingUnavailable',
  { reason: Schema.Literal('NO_SUPPORTED_PRIVACY_PATH') },
) {}
