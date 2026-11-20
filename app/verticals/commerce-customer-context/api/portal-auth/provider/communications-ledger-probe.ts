import { Effect, Option } from 'effect';
import { withCause } from '../problems-support.ts';

import { PortalAuthIssuanceStateUnavailable } from '../../../src/portal-auth/communications/issuance-state-unavailable.ts';
import type { IssuanceLedgerProbe } from '../../../src/portal-auth/communications/protected-handoff.ts';
import type { CommercePortalAuthRecoveryStore } from './recovery/store-service.ts';

/**
 * Auth's own Current lifecycle fact about a held issuance, read from the recovery ledger Auth already keeps (no new
 * ledger): a verification or reset token the ledger still offers for the SAME provider subject is CURRENT; one it no longer
 * offers was consumed, revoked, superseded or has expired. A one-time code has no ledger: its currentness is its own expiry
 * and the lifecycle events Auth settles.
 */
export const ledgerProbeOver =
  (
    store: Pick<CommercePortalAuthRecoveryStore, 'peekEmailVerificationLedger' | 'peekPasswordResetLedger'>,
  ): IssuanceLedgerProbe =>
  (held) => {
    const { issuance, ledgerToken } = held;
    if (ledgerToken === undefined || issuance.flow === 'otp') {
      return Effect.succeed('CURRENT');
    }
    const peek = issuance.flow === 'verify-email' ? store.peekEmailVerificationLedger : store.peekPasswordResetLedger;
    return peek({ token: ledgerToken }).pipe(
      Effect.map((binding) =>
        Option.exists(binding, ({ providerSubjectId }) => providerSubjectId === issuance.providerSubjectId)
          ? ('CURRENT' as const)
          : ('NO_LONGER_CURRENT' as const),
      ),
      Effect.mapError((cause) => withCause(new PortalAuthIssuanceStateUnavailable({ flow: issuance.flow }), cause)),
    );
  };
