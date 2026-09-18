import { Context } from 'effect';

import type { CommercePortalAuthAccountCreationProvider } from './account-create.ts';

export class CommercePortalAuthAccountCreationProviderService extends Context.Service<
  CommercePortalAuthAccountCreationProviderService,
  CommercePortalAuthAccountCreationProvider
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-creation-provider-service/CommercePortalAuthAccountCreationProviderService',
) {}
