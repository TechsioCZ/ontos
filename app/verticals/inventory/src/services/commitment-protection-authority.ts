import type { Effect as EffectType } from 'effect';
import { Context, Effect } from 'effect';

import type {
  ReservationAuthorityIssueRequest,
  ReservationAuthorityObservation,
} from '../../shared/domain/reservation-authority.ts';

export interface CommitmentProtectionAuthority {
  readonly establish: (request: ReservationAuthorityIssueRequest) => EffectType.Effect<ReservationAuthorityObservation>;
}

export const CommitmentProtectionAuthorityPort = Context.Reference<CommitmentProtectionAuthority>(
  '@app/inventory/services/commitment-protection-authority/CommitmentProtectionAuthorityPort',
  {
    defaultValue: () => ({
      establish: ({ effectId }) =>
        Effect.succeed({
          effectAbsenceProven: false,
          effectId,
          kind: 'UNAVAILABLE',
          recovery: 'VERIFY_OR_RECOVER_ORIGINAL_EFFECT',
        }),
    }),
  },
);
