import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAccountCreateInput, CommercePortalAuthCreatedAccount } from './account-create.ts';
import type { CommercePortalAuthAccountCreationRejected } from './account-creation-rejected.ts';
import type { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';

/**
 * The governed identity travels with the credential rather than beside it: the provider writes the
 * creation correlation from inside its own call, so it must be handed the exact invocation the
 * Attempt claimed, not just the account fields.
 */
export interface CommercePortalAuthAccountCreationGateway {
  readonly create: (
    input: Pick<
      CommercePortalAccountCreateInput,
      'email' | 'enrollmentAttemptId' | 'name' | 'ownerInvocationId' | 'password' | 'tenantId'
    >,
  ) => Effect.Effect<
    CommercePortalAuthCreatedAccount,
    CommercePortalAuthAccountCreationRejected | CommercePortalAuthAccountCreationUnavailable
  >;
}

export class CommercePortalAuthAccountCreationGatewayService extends Context.Service<
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationGateway
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-creation-gateway-service/CommercePortalAuthAccountCreationGatewayService',
) {}
