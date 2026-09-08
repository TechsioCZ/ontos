import { Schema } from 'effect';

import {
  PositiveRelationshipRevisionSchema,
  RelationshipErrorBase,
} from './shared.ts';

export class PartyRelationshipRevisionConflict extends Schema.TaggedError<PartyRelationshipRevisionConflict>()(
  'PartyRelationshipRevisionConflict',
  {
    ...RelationshipErrorBase,
    actualRevision: PositiveRelationshipRevisionSchema,
    code: Schema.Literal('party_relationship_revision_conflict'),
    expectedRevision: PositiveRelationshipRevisionSchema,
  }
) {}
