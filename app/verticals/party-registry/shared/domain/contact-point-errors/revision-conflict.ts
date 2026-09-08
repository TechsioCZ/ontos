import { Schema } from 'effect';

import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointRevisionConflict extends Schema.TaggedError<PartyContactPointRevisionConflict>()(
  'PartyContactPointRevisionConflict',
  {
    code: Schema.Literal('party_contact_point_revision_conflict'),
    currentRevision: Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1)
    ),
    reason: ContactPointErrorReasonSchema,
  }
) {}
