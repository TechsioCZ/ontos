import { Schema } from 'effect';

import { ownerEffectErrorFields } from './owner-effect-fields.ts';

export class CommerceEnrollmentOwnerEffectRejected extends Schema.TaggedError<CommerceEnrollmentOwnerEffectRejected>()(
  'CommerceEnrollmentOwnerEffectRejected',
  ownerEffectErrorFields,
) {}
