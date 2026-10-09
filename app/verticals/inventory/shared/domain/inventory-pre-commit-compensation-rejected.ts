import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

export class InventoryPreCommitCompensationRejected extends Schema.TaggedError<InventoryPreCommitCompensationRejected>()(
  'InventoryPreCommitCompensationRejected',
  {
    code: Schema.Literal('inventory_pre_commit_compensation_rejected'),
    createEffectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'AUTHORIZATION_TARGET_MISMATCH',
      'EFFECT_NOT_FOUND',
      'ATTEMPT_SCOPE_MISMATCH',
      'EFFECT_ID_CONFLICT',
      'INVALID_CLEANUP_OBSERVATION',
      'RELEASE_CONFLICT',
    ]),
  },
) {}
