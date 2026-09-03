/* eslint-disable max-classes-per-file -- Contact Point exposes one closed typed domain-failure vocabulary. */
import { Schema } from 'effect';
import { PartyContactPointRefSchema } from '../resources/party-contact-point.ts';
import { PartyRefSchema } from '../resources/party.ts';

const ReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export class PartyContactPointPartyNotFound extends Schema.TaggedError<PartyContactPointPartyNotFound>()(
  'PartyContactPointPartyNotFound',
  {
    code: Schema.Literal('party_contact_point_party_not_found'),
    partyRef: PartyRefSchema,
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointNotFound extends Schema.TaggedError<PartyContactPointNotFound>()(
  'PartyContactPointNotFound',
  {
    code: Schema.Literal('party_contact_point_not_found'),
    contactPointRef: PartyContactPointRefSchema,
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointAlreadyExists extends Schema.TaggedError<PartyContactPointAlreadyExists>()(
  'PartyContactPointAlreadyExists',
  {
    code: Schema.Literal('party_contact_point_already_exists'),
    existingContactPointRef: PartyContactPointRefSchema,
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointInvalid extends Schema.TaggedError<PartyContactPointInvalid>()(
  'PartyContactPointInvalid',
  {
    code: Schema.Literal('party_contact_point_invalid'),
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointRevisionConflict extends Schema.TaggedError<PartyContactPointRevisionConflict>()(
  'PartyContactPointRevisionConflict',
  {
    code: Schema.Literal('party_contact_point_revision_conflict'),
    currentRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointLifecycleConflict extends Schema.TaggedError<PartyContactPointLifecycleConflict>()(
  'PartyContactPointLifecycleConflict',
  {
    code: Schema.Literal('party_contact_point_lifecycle_conflict'),
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointCorrectionRequired extends Schema.TaggedError<PartyContactPointCorrectionRequired>()(
  'PartyContactPointCorrectionRequired',
  {
    code: Schema.Literal('party_contact_point_correction_required'),
    reason: ReasonSchema,
  },
) {}

export class PartyContactPointPersistenceUnavailable extends Schema.TaggedError<PartyContactPointPersistenceUnavailable>()(
  'PartyContactPointPersistenceUnavailable',
  {
    code: Schema.Literal('party_contact_point_persistence_unavailable'),
    reason: ReasonSchema,
  },
) {}
