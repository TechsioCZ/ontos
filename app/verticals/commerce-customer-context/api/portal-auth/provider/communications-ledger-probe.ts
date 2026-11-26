import { Effect, Match } from 'effect';

import { PortalAuthIssuanceStateUnavailable } from '../../../src/portal-auth/communications/issuance-state-unavailable.ts';
import type { IssuanceLedgerProbe } from '../../../src/portal-auth/communications/protected-handoff.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY } from './mfa/plugin.ts';
import type {
  CommercePortalAuthIssuanceLedgerState,
  CommercePortalAuthRecoveryStore,
} from './recovery/store-service.ts';
import type { CommercePortalAuthRecoveryUnavailable } from './recovery/unavailable.ts';
import { withSafeCause } from './safe-failure.ts';

/**
 * Auth's own Current lifecycle fact about a held issuance, read from state Auth already keeps (no new ledger) and reported as the
 * REAL distinct state its rows prove, never as one catch-all:
 * - a verification link is CURRENT while its ledger row is live for the same account; EXPIRED when the row is past its expiry;
 *   SUPERSEDED when the token is now registered for another binding; CONSUMED when the row is gone and the address is verified;
 * - a reset link is read from its ledger row: `pending` and live is CURRENT, `expired` or past its expiry EXPIRED, `consumed`
 *   (or claimed for a dispatch) CONSUMED, registered for another account SUPERSEDED;
 * - a one-time code is read from the REAL two-factor state Better Auth keeps for it: its challenge row is deleted by a
 *   verification (CONSUMED), replaced by a newer code (SUPERSEDED), past its expiry (EXPIRED) or counted to the plugin's own
 *   failed-attempt limit (CONSUMED: a spent or exhausted code is never sent as a valid one).
 * An issuance whose rows say nothing (it was not located, or it has no ledger token) is NOT_RESUMABLE: Auth cannot continue it,
 * and it is never reported as revoked. The failure of a read keeps only its safe kind, never a statement, parameter or code.
 */
export const ledgerProbeOver =
  (
    store: Pick<
      CommercePortalAuthRecoveryStore,
      'readEmailVerificationIssuanceState' | 'readOtpIssuanceState' | 'readPasswordResetIssuanceState'
    >,
  ): IssuanceLedgerProbe =>
  (held) => {
    const { issuance, ledgerToken } = held;
    if (ledgerToken === undefined) {
      return Effect.succeed('NOT_RESUMABLE');
    }
    const unavailable = (cause: unknown) =>
      withSafeCause(new PortalAuthIssuanceStateUnavailable({ flow: issuance.flow }), cause);
    const read: Effect.Effect<CommercePortalAuthIssuanceLedgerState, CommercePortalAuthRecoveryUnavailable> =
      Match.value(issuance.flow).pipe(
        Match.when('otp', () =>
          store.readOtpIssuanceState({
            challenge: ledgerToken,
            maxFailedAttempts: COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts,
            otp: held.secret,
          }),
        ),
        Match.when('verify-email', () =>
          store.readEmailVerificationIssuanceState({
            providerSubjectId: issuance.providerSubjectId,
            token: ledgerToken,
          }),
        ),
        Match.when('reset-password', () =>
          store.readPasswordResetIssuanceState({ providerSubjectId: issuance.providerSubjectId, token: ledgerToken }),
        ),
        Match.exhaustive,
      );
    return read.pipe(
      Effect.map((state) =>
        Match.value(state).pipe(
          Match.when('NOT_LOCATED', () => 'NOT_RESUMABLE' as const),
          Match.orElse((known) => known),
        ),
      ),
      Effect.mapError(unavailable),
    );
  };
