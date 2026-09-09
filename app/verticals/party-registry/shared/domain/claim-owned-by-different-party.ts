import { Schema } from 'effect';

export class ClaimOwnedByDifferentParty extends Schema.TaggedError<ClaimOwnedByDifferentParty>()(
  'ClaimOwnedByDifferentParty',
  {
    code: Schema.Literal('claim_owned_by_different_party'),
    reason: Schema.String,
  },
) {}
