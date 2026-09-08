import { Schema } from 'effect';

import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipNotFound extends Schema.TaggedError<PartyRelationshipNotFound>()(
  'PartyRelationshipNotFound',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_not_found'),
  }
) {}
