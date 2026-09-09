import { Schema } from 'effect';

import { PartyContactPointRefSchema } from '../../resources/party-contact-point.ts';
import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointNotFound extends Schema.TaggedError<PartyContactPointNotFound>()(
  'PartyContactPointNotFound',
  {
    code: Schema.Literal('party_contact_point_not_found'),
    contactPointRef: PartyContactPointRefSchema,
    reason: ContactPointErrorReasonSchema,
  },
) {}
