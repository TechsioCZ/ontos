import { Schema } from 'effect';

/** Another policy already covers some of the same Price keys at the same time, or the policy already ended. */
export class ExternalPriceSourcePolicyConflict extends Schema.TaggedError<ExternalPriceSourcePolicyConflict>()(
  'ExternalPriceSourcePolicyConflict',
  {
    code: Schema.Literals(['external_price_source_policy_already_ended', 'external_price_source_policy_overlap']),
    reason: Schema.String,
  },
) {}
