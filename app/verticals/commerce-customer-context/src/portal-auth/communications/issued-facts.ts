import { Context } from 'effect';

import type { CommercePortalAuthRecoveryStore } from '../../../api/portal-auth/provider/recovery/store-service.ts';

/**
 * What Auth itself STORED about an issuance it was just handed, and the only part of its recovery store the Communications-routed
 * delivery reads: the ledger binding of a verification or reset token (with its real expiry) and the two-factor challenge of a
 * one-time code. A narrow service keeps the delivery from depending on the whole store.
 */
export type IssuedFactsService = Pick<
  CommercePortalAuthRecoveryStore,
  'locateOtpChallenge' | 'peekEmailVerificationLedger' | 'peekPasswordResetLedger'
>;

export class CommercePortalAuthIssuedFacts extends Context.Service<CommercePortalAuthIssuedFacts, IssuedFactsService>()(
  '@app/commerce-customer-context/portal-auth/communications/issued-facts/CommercePortalAuthIssuedFacts',
) {}
