import { Context } from 'effect';

import type { CommercePortalAuthSessionProvider } from './lifecycle.ts';

export class CommercePortalAuthSessionProviderService extends Context.Service<
  CommercePortalAuthSessionProviderService,
  CommercePortalAuthSessionProvider
>()(
  '@app/commerce-customer-context/api/portal-auth/session/provider-service/CommercePortalAuthSessionProviderService',
) {}
