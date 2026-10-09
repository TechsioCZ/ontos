import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';

interface CommercePortalAuthAccountCreationReconciliationResult {
  readonly providerSubjectId: string;
}

/**
 * Reconciles one exact governed account-creation invocation with the provider. A correlated
 * account is returned only after its verification email has been successfully reissued.
 */
export interface CommercePortalAuthAccountCreationReconciliation {
  readonly reissueVerificationEmail: (input: {
    readonly ownerInvocationId: string;
  }) => Effect.Effect<
    Option.Option<CommercePortalAuthAccountCreationReconciliationResult>,
    CommercePortalAuthAccountCreationUnavailable
  >;
}

export class CommercePortalAuthAccountCreationReconciliationService extends Context.Service<
  CommercePortalAuthAccountCreationReconciliationService,
  CommercePortalAuthAccountCreationReconciliation
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-creation-reconciliation-service/CommercePortalAuthAccountCreationReconciliationService',
) {}
