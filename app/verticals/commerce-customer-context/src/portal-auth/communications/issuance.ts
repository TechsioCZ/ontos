import { Schema } from 'effect';
import type { DateTime, Redacted } from 'effect';

import type { PortalAuthEmailFlow, PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';

/**
 * Everything Auth may tell Communications about one issuance. It is deliberately a SEPARATE type from `HeldIssuance`:
 * there is no secret, no address and no provider token on it, so a request, an intent, a history row or a log built
 * from it cannot carry one.
 */
export interface PortalAuthIssuance {
  /** The enrollment operation that caused a verification issuance. A DIFFERENT identity than `issuanceRef`; absent otherwise. */
  readonly enrollmentOwnerInvocationId?: string;
  readonly expiresAt: DateTime.Utc;
  readonly flow: PortalAuthEmailFlow;
  readonly issuanceRef: PortalAuthIssuanceRef;
  readonly issuedAt: DateTime.Utc;
  /** The provider subject the issuance was made for. Never an e-mail match. */
  readonly providerSubjectId: string;
}

/**
 * The protected side of one issuance: held by Auth alone, in one process, until it expires or is spent. Every field
 * is `Redacted`, so printing, logging and serializing it shows `<redacted>`.
 * - `endpoint` is the ORIGINAL address Auth bound to the issuance;
 * - `secret` is the verification link, the reset link or the one-time code;
 * - `ledgerToken` is the provider token that Auth's own ledger knows the issuance by (absent for a one-time code).
 */
export interface HeldIssuance {
  readonly endpoint: Redacted.Redacted;
  readonly issuance: PortalAuthIssuance;
  readonly ledgerToken?: Redacted.Redacted;
  readonly secret: Redacted.Redacted;
}

/**
 * Auth's CURRENT lifecycle fact about one issuance:
 * - CURRENT: held here, not expired, still offered by Auth's own ledger;
 * - EXPIRED / CONSUMED / REVOKED: no longer usable;
 * - NO_LONGER_CURRENT: Auth's ledger no longer offers it (consumed, revoked or superseded);
 * - NOT_RESUMABLE: this runtime does not hold the issuance (a restart or another instance) and never reproduces it.
 */
export const IssuanceCurrentnessSchema = Schema.Literals([
  'CONSUMED',
  'CURRENT',
  'EXPIRED',
  'NO_LONGER_CURRENT',
  'NOT_RESUMABLE',
  'REVOKED',
]);
export type IssuanceCurrentness = typeof IssuanceCurrentnessSchema.Type;
