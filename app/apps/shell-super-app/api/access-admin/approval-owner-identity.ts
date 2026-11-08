import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import { Context, Effect, Schema } from 'effect';

import type { ApprovalCommandFailure } from './approvals-contract.ts';
import { accessAdminForbiddenProblem } from './session.ts';

export interface ApprovalOwnerIdentityService {
  readonly resolve: (
    headers: Headers,
    admitted: OperationalScope,
    legalEntityId?: string,
  ) => Effect.Effect<TrustedPrincipalContext, ApprovalCommandFailure>;
}
export class ApprovalOwnerIdentity extends Context.Service<ApprovalOwnerIdentity, ApprovalOwnerIdentityService>()(
  '@app/shell-super-app/api/access-admin/approval-owner-identity/ApprovalOwnerIdentity',
) {}

/**
 * A company is selected by the real session, never projected onto the inbox's tenant principal.
 * Return that original resolved principal unchanged so its authentication provenance stays intact.
 */
export const requireApprovalOwnerIdentity = Effect.fn('ApprovalOwnerIdentity.require')(function* requireIdentity(
  admitted: OperationalScope,
  principal: TrustedPrincipalContext,
  legalEntityId?: string,
) {
  const valid = Schema.is(TrustedPrincipalContextSchema);
  if (
    !valid(admitted) ||
    !valid(principal) ||
    admitted.legalEntityId !== undefined ||
    admitted.authenticationNamespaceId === undefined ||
    !['session', 'support_impersonation'].includes(admitted.authMethod) ||
    principal.authMethod !== admitted.authMethod ||
    principal.tenantId !== admitted.tenantId ||
    principal.principalId !== admitted.principalId ||
    principal.authenticationNamespaceId !== admitted.authenticationNamespaceId ||
    principal.authBindingId !== admitted.authBindingId ||
    principal.authContextRef !== admitted.authContextRef ||
    principal.impersonatedByPrincipalId !== admitted.impersonatedByPrincipalId ||
    principal.trustedStorefrontId !== undefined ||
    principal.legalEntityId !== legalEntityId
  ) {
    return yield* Effect.fail(
      accessAdminForbiddenProblem('The current Shell session does not match this proposal and its company context.'),
    );
  }
  return principal;
});
