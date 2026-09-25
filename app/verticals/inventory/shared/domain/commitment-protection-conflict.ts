import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

export class CommitmentProtectionConflict extends Schema.TaggedError<CommitmentProtectionConflict>()(
  'CommitmentProtectionConflict',
  {
    code: Schema.Literal('commitment_protection_conflict'),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.Literal('MATERIAL_INTENT_CONFLICT'),
  },
) {}
