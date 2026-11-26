import { Config, Context, Effect, Layer, Option, Schema } from 'effect';

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

/** The reviewed deployment value naming the trusted Tenant of this deployment's Portal Auth realm. */
export const PORTAL_AUTH_TRUSTED_TENANT_VARIABLE = 'COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID';

const TrustedTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PortalAuthTrustedTenantId'));
const decodeTrustedTenantId = Schema.decodeUnknownOption(TrustedTenantIdSchema);

const unavailable = (reason: PortalAuthTrustedScopeUnavailable['reason']) =>
  Effect.fail(new PortalAuthTrustedScopeUnavailable({ reason }));

/** The trusted scope a configured value names: unset or blank is NOT_CONFIGURED, a value that names no Tenant is INVALID. */
export const trustedScopeOfConfiguredTenant = (
  configured: Option.Option<string>,
): PortalAuthTrustedScopeService['current'] =>
  Option.match(
    configured.pipe(
      Option.map((value) => value.trim()),
      Option.filter((value) => value.length > 0),
    ),
    {
      onNone: () => unavailable('NOT_CONFIGURED'),
      onSome: (value) =>
        Option.match(decodeTrustedTenantId(value), {
          onNone: () => unavailable('INVALID'),
          onSome: (tenantId) => Effect.succeed({ tenantId }),
        }),
    },
  );

/**
 * The realm's trusted Tenant from the deployment's reviewed configuration (`COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID`), read once
 * when the layer is built. It is never derived from a request host, header or payload. A deployment that leaves it unset, blank
 * or malformed gets a scope that always fails with the typed, value-free reason, so the relay relays nothing (fail closed).
 * The realm is Tenant-wide: it names no Legal Entity.
 */
export const configuredTrustedScopeLayer = Layer.effect(
  CommercePortalAuthTrustedScope,
  Config.String(PORTAL_AUTH_TRUSTED_TENANT_VARIABLE).pipe(
    Config.option,
    Effect.map(trustedScopeOfConfiguredTenant),
    Effect.orElseSucceed(() => unavailable('INVALID')),
    Effect.map((current) => ({ current })),
  ),
);
