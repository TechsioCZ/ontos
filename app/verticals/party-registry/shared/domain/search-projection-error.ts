import { Schema } from 'effect';

export class PartySearchProjectionUnavailable extends Schema.TaggedError<PartySearchProjectionUnavailable>()(
  'PartySearchProjectionUnavailable',
  {
    code: Schema.Literal('party_search_projection_unavailable'),
    reason: Schema.String,
  },
) {}
