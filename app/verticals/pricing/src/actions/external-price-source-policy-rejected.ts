import { Schema } from 'effect';

export class ExternalPriceSourcePolicyRejected extends Schema.TaggedError<ExternalPriceSourcePolicyRejected>()(
  'ExternalPriceSourcePolicyRejected',
  {
    code: Schema.Literals([
      'external_price_source_policy_end_outside_period',
      'external_price_source_policy_not_found',
      'external_price_source_policy_scope_mismatch',
    ]),
    reason: Schema.String,
  },
) {}
