import { Schema } from 'effect';

import { PartyRefSchema } from '../../resources/party.ts';
import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointPartyNotFound extends Schema.TaggedError<PartyContactPointPartyNotFound>()(
  'PartyContactPointPartyNotFound',
  {
    code: Schema.Literal('party_contact_point_party_not_found'),
    partyRef: PartyRefSchema,
    reason: ContactPointErrorReasonSchema,
  }
) {}
