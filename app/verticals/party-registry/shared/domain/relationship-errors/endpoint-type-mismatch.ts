import { Schema } from 'effect';
import {
  RelationshipEndpointSchema,
  RelationshipErrorBase,
  RelationshipErrorPartyTypeSchema,
} from './shared.ts';

export class PartyRelationshipEndpointTypeMismatch extends Schema.TaggedError<PartyRelationshipEndpointTypeMismatch>()(
  'PartyRelationshipEndpointTypeMismatch',
  {
    ...RelationshipErrorBase,
    actualPartyType: RelationshipErrorPartyTypeSchema,
    code: Schema.Literal('party_relationship_endpoint_type_mismatch'),
    endpoint: RelationshipEndpointSchema,
    expectedPartyType: RelationshipErrorPartyTypeSchema,
  },
) {}
