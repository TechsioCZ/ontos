import { Schema } from 'effect';

export class PartyAliasResolutionUnavailable extends Schema.TaggedError<PartyAliasResolutionUnavailable>()(
  'PartyAliasResolutionUnavailable',
  {
    code: Schema.Literal('party_alias_resolution_unavailable'),
    reason: Schema.String,
  }
) {}
