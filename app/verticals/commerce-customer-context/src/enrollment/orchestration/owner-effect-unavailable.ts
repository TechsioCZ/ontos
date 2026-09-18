import { Schema } from 'effect';

import { ownerEffectErrorFields } from './owner-effect-fields.ts';

export class CommerceEnrollmentOwnerEffectUnavailable extends Schema.TaggedError<CommerceEnrollmentOwnerEffectUnavailable>()(
  'CommerceEnrollmentOwnerEffectUnavailable',
  ownerEffectErrorFields,
) {}
