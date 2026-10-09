import { Context } from 'effect';

import type { CommercePortalAuthMfaProvider } from './contracts.ts';

export class CommercePortalAuthMfaProviderService extends Context.Service<
  CommercePortalAuthMfaProviderService,
  CommercePortalAuthMfaProvider
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/mfa/provider-service/CommercePortalAuthMfaProviderService',
) {}
