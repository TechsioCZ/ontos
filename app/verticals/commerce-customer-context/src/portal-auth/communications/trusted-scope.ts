import { Context, Effect, Layer } from 'effect';

import { PortalAuthTrustedScopeUnavailable } from './trusted-scope-unavailable.ts';

/** The trusted Tenant (and optional Legal Entity) the Portal Auth realm of this deployment operates in. Never taken from a request. */
export interface PortalAuthTrustedScopeService {
  readonly current: Effect.Effect<
    { readonly legalEntityId?: string; readonly tenantId: string },
    PortalAuthTrustedScopeUnavailable
  >;
}

export class CommercePortalAuthTrustedScope extends Context.Service<
  CommercePortalAuthTrustedScope,
  PortalAuthTrustedScopeService
>()('@app/commerce-customer-context/portal-auth/communications/trusted-scope/CommercePortalAuthTrustedScope') {}

export const unconfiguredTrustedScopeLayer = Layer.succeed(CommercePortalAuthTrustedScope, {
  current: Effect.fail(new PortalAuthTrustedScopeUnavailable({ reason: 'NOT_CONFIGURED' })),
});
