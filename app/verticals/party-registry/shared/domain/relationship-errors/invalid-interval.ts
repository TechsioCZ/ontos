import { Schema } from 'effect';
import { RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipInvalidInterval extends Schema.TaggedError<PartyRelationshipInvalidInterval>()(
  'PartyRelationshipInvalidInterval',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_invalid_interval'),
  },
) {}
