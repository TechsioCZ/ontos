import { Schema } from 'effect';

import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipPersistenceUnavailable extends Schema.TaggedError<PartyRelationshipPersistenceUnavailable>()(
  'PartyRelationshipPersistenceUnavailable',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_persistence_unavailable'),
  }
) {}
