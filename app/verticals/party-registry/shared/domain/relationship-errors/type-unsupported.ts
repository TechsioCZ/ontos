import { Schema } from 'effect';

import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipTypeUnsupported extends Schema.TaggedError<PartyRelationshipTypeUnsupported>()(
  'PartyRelationshipTypeUnsupported',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_type_unsupported'),
  },
) {}
