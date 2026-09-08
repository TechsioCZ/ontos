import { Schema } from 'effect';

import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointInvalid extends Schema.TaggedError<PartyContactPointInvalid>()(
  'PartyContactPointInvalid',
  {
    code: Schema.Literal('party_contact_point_invalid'),
    reason: ContactPointErrorReasonSchema,
  }
) {}
