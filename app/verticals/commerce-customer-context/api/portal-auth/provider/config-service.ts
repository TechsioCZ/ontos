import { Context } from 'effect';

import type { CommercePortalAuthConfigValue } from './config.ts';

export class CommercePortalAuthConfig extends Context.Service<
  CommercePortalAuthConfig,
  CommercePortalAuthConfigValue
>()('@app/commerce-customer-context/api/portal-auth/provider/config-service/CommercePortalAuthConfig') {}
