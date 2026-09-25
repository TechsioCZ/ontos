import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

export class CommitmentProtectionRejected extends Schema.TaggedError<CommitmentProtectionRejected>()(
  'CommitmentProtectionRejected',
  {
    code: Schema.Literal('commitment_protection_rejected'),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'CONFIRMATION_SCOPE_MISMATCH',
      'PROTECTION_IDENTITY_CONFLICT',
      'SIBLING_PROTECTION_FORBIDDEN',
      'AUTHORITY_SCOPE_MISMATCH',
      'PROOF_SCOPE_MISMATCH',
      'INVALID_PROTECTION',
      'REVISION_CONFLICT',
    ]),
  },
) {}
