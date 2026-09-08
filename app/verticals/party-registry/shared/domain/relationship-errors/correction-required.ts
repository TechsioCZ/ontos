import { Schema } from 'effect';

import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipCorrectionRequired extends Schema.TaggedError<PartyRelationshipCorrectionRequired>()(
  'PartyRelationshipCorrectionRequired',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_correction_required'),
    fact: Schema.Literals([
      'endpoint',
      'relationshipType',
      'validFrom',
      'validTo',
    ]),
  }
) {}
