import { Schema } from 'effect';

/** The exact key already has a grant from this start under this authority and mapping; it is never replaced. */
export class ExternalPriceSourceAuthorityGrantConflict extends Schema.TaggedError<ExternalPriceSourceAuthorityGrantConflict>()(
  'ExternalPriceSourceAuthorityGrantConflict',
  {
    code: Schema.Literal('external_price_source_authority_already_granted'),
    reason: Schema.String,
  },
) {}
