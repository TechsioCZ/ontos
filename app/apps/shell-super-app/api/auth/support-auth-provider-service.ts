import { Context } from 'effect';

import type { SupportAuthProvider } from './impersonation-service.ts';

export class SupportAuthProviderService extends Context.Service<
  SupportAuthProviderService,
  SupportAuthProvider
>()(
  '@app/shell-super-app/api/auth/support-auth-provider-service/SupportAuthProviderService'
) {}
