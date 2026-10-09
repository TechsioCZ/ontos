import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

export class InventoryPreCommitCompensationUnavailable extends Schema.TaggedError<InventoryPreCommitCompensationUnavailable>()(
  'InventoryPreCommitCompensationUnavailable',
  {
    code: Schema.Literal('inventory_pre_commit_compensation_unavailable'),
    createEffectId: ReservationAuthorityEffectIdSchema,
    reason: boundedText,
    retryable: Schema.Literal(true),
  },
) {}
