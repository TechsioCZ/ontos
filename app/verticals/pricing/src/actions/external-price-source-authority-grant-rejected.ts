import { Schema } from 'effect';

export class ExternalPriceSourceAuthorityGrantRejected extends Schema.TaggedError<ExternalPriceSourceAuthorityGrantRejected>()(
  'ExternalPriceSourceAuthorityGrantRejected',
  {
    code: Schema.Literal('external_price_source_authority_scope_mismatch'),
    reason: Schema.String,
  },
) {}
