import { Schema } from 'effect';

/**
 * Why Privacy bound nothing:
 * - CALLER_NOT_SOURCE: the verified caller is not the module that owns the named account;
 * - NO_CURRENT_POLICY / AMBIGUOUS_POLICY: no, or more than one, exact current Privacy policy for this source purpose;
 * - OCCURRENCE_NOT_CURRENT: the occurrence the source names has already stopped being usable;
 * - SCOPE_CONFLICT: the account is already bound in another Legal Entity scope of this Tenant.
 */
export class PreVerificationBindingRejected extends Schema.TaggedError<PreVerificationBindingRejected>()(
  'PreVerificationBindingRejected',
  {
    code: Schema.Literal('pre_verification_binding_rejected'),
    reason: Schema.Literals([
      'CALLER_NOT_SOURCE',
      'NO_CURRENT_POLICY',
      'AMBIGUOUS_POLICY',
      'OCCURRENCE_NOT_CURRENT',
      'SCOPE_CONFLICT',
    ]),
  },
) {}
