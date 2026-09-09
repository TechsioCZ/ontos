import { Schema } from 'effect';

import { ContactPointErrorReasonSchema } from './shared.ts';

export class PartyContactPointPersistenceUnavailable extends Schema.TaggedError<PartyContactPointPersistenceUnavailable>()(
  'PartyContactPointPersistenceUnavailable',
  {
    code: Schema.Literal('party_contact_point_persistence_unavailable'),
    reason: ContactPointErrorReasonSchema,
  },
) {}
