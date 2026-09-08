import { Schema } from 'effect';

import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointLifecycleConflict extends Schema.TaggedError<PartyContactPointLifecycleConflict>()(
  'PartyContactPointLifecycleConflict',
  {
    code: Schema.Literal('party_contact_point_lifecycle_conflict'),
    reason: ContactPointErrorReasonSchema,
  }
) {}
