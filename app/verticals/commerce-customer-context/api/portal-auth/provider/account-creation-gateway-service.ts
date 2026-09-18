import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAccountCreateInput, CommercePortalAuthCreatedAccount } from './account-create.ts';
import type { CommercePortalAuthAccountCreationRejected } from './account-creation-rejected.ts';
import type { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';

export interface CommercePortalAuthAccountCreationGateway {
  readonly create: (
    input: Pick<CommercePortalAccountCreateInput, 'email' | 'name' | 'password'>,
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
