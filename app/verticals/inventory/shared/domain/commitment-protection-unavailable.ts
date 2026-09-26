import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

export class CommitmentProtectionUnavailable extends Schema.TaggedError<CommitmentProtectionUnavailable>()(
  'CommitmentProtectionUnavailable',
  {
    code: Schema.Literal('commitment_protection_unavailable'),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
