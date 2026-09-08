import { Schema } from 'effect';

import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointCorrectionRequired extends Schema.TaggedError<PartyContactPointCorrectionRequired>()(
  'PartyContactPointCorrectionRequired',
  {
    code: Schema.Literal('party_contact_point_correction_required'),
    reason: ContactPointErrorReasonSchema,
  }
) {}
