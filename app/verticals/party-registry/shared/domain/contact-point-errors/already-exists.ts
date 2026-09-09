import { Schema } from 'effect';

import { PartyContactPointRefSchema } from '../../resources/party-contact-point.ts';
import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointAlreadyExists extends Schema.TaggedError<PartyContactPointAlreadyExists>()(
  'PartyContactPointAlreadyExists',
  {
    code: Schema.Literal('party_contact_point_already_exists'),
    existingContactPointRef: PartyContactPointRefSchema,
    reason: ContactPointErrorReasonSchema,
  },
) {}
