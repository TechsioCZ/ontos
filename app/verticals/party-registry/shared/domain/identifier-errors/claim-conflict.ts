import { Schema } from 'effect';

export class OfficialIdentifierClaimConflict extends Schema.TaggedError<OfficialIdentifierClaimConflict>()(
  'OfficialIdentifierClaimConflict',
  {
    code: Schema.Literal('party_identifier_claim_conflict'),
    reason: Schema.String,
  },
) {}
