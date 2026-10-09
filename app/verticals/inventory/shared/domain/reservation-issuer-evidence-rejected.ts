import { Schema } from 'effect';

import { reservationIssuerCommonFailureFields } from './reservation-issuer-failure-fields.ts';

export class ReservationIssuerEvidenceRejected extends Schema.TaggedError<ReservationIssuerEvidenceRejected>()(
  'ReservationIssuerEvidenceRejected',
  {
    ...reservationIssuerCommonFailureFields,
    reason: Schema.Literals([
      'EFFECT_IDENTITY_MISMATCH',
      'ISSUER_IDENTITY_MISMATCH',
      'OPERATION_MISMATCH',
      'EXACT_RESERVATION_SCOPE_MISMATCH',
      'INVALID_PROOF_VALIDITY',
    ]),
  },
) {}
