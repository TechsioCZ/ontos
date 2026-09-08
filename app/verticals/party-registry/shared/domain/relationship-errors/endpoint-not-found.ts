import { Schema } from 'effect';

import { PartyRefSchema } from '../../resources/party.ts';
import { RelationshipEndpointSchema, RelationshipErrorBase } from './shared.ts';

export class PartyRelationshipEndpointNotFound extends Schema.TaggedError<PartyRelationshipEndpointNotFound>()(
  'PartyRelationshipEndpointNotFound',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_endpoint_not_found'),
    endpoint: RelationshipEndpointSchema,
    partyRef: PartyRefSchema,
  }
) {}
