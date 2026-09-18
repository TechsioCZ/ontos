import { Schema } from 'effect';

import { ownerEffectErrorFields } from './owner-effect-fields.ts';

export class CommerceEnrollmentOwnerEffectIndeterminate extends Schema.TaggedError<CommerceEnrollmentOwnerEffectIndeterminate>()(
  'CommerceEnrollmentOwnerEffectIndeterminate',
  ownerEffectErrorFields,
) {}
