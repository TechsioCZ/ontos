import { Schema } from 'effect';

import { PartyRelationshipRefSchema } from '../../resources/party-relationship.ts';
import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipOverlapConflict extends Schema.TaggedError<PartyRelationshipOverlapConflict>()(
  'PartyRelationshipOverlapConflict',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_overlap_conflict'),
    conflictingRelationshipRef: Schema.optionalKey(PartyRelationshipRefSchema),
  },
) {}
