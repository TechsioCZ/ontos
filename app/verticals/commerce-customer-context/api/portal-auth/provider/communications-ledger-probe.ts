import { Effect, Option } from 'effect';
import { withCause } from '../problems-support.ts';

import { PortalAuthIssuanceStateUnavailable } from '../../../src/portal-auth/communications/issuance-state-unavailable.ts';
import type { IssuanceLedgerProbe } from '../../../src/portal-auth/communications/protected-handoff.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY } from './mfa/plugin.ts';
import type { CommercePortalAuthRecoveryStore } from './recovery/store-service.ts';

/**
 * Auth's own Current lifecycle fact about a held issuance, read from state Auth already keeps (no new ledger):
 * - a verification or reset token the recovery ledger still offers for the SAME provider subject is CURRENT; one it no longer
 *   offers was consumed, revoked, superseded or has expired;
 * - a one-time code is read from the REAL two-factor state Better Auth keeps for it: its challenge row is spent by a
 *   verification (it is consumed) and counts every failed presentation, so a missing challenge or one at the plugin's own
 *   failed-attempt limit is CONSUMED (a spent or exhausted code is never sent as a valid one). The challenge identifier is
 *   held as the issuance's `ledgerToken`; a code whose challenge could not be located is never held.
 */
export const ledgerProbeOver =
  (
    store: Pick<
      CommercePortalAuthRecoveryStore,
      'peekEmailVerificationLedger' | 'peekPasswordResetLedger' | 'readOtpChallenge'
    >,
  ): IssuanceLedgerProbe =>
  (held) => {
    const { issuance, ledgerToken } = held;
    if (ledgerToken === undefined) {
      return Effect.succeed('NO_LONGER_CURRENT');
    }
    const unavailable = (cause: unknown) =>
      withCause(new PortalAuthIssuanceStateUnavailable({ flow: issuance.flow }), cause);
    if (issuance.flow === 'otp') {
      return store.readOtpChallenge({ challenge: ledgerToken }).pipe(
        Effect.map((challenge) =>
          Option.exists(challenge, ({ attempts }) => attempts < COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts)
            ? ('CURRENT' as const)
            : ('CONSUMED' as const),
        ),
        Effect.mapError(unavailable),
      );
    }
    const peek = issuance.flow === 'verify-email' ? store.peekEmailVerificationLedger : store.peekPasswordResetLedger;
    return peek({ token: ledgerToken }).pipe(
      Effect.map((binding) =>
        Option.exists(binding, ({ providerSubjectId }) => providerSubjectId === issuance.providerSubjectId)
          ? ('CURRENT' as const)
          : ('NO_LONGER_CURRENT' as const),
      ),
      Effect.mapError(unavailable),
    );
  };
