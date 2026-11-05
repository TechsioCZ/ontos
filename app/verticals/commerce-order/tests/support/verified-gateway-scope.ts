import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { VerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Schema } from 'effect';

export const buyerPrincipalId = '50000000-0000-4000-8000-000000000001';
export const impersonatingPrincipalId = '60000000-0000-4000-8000-000000000001';

/** A Shell-verified calling module acting for the subject. Pure provenance seam; no signature is checked. */
export const moduleActor = (
  appId: string,
  principalId = '20000000-0000-4000-8000-000000000001',
): VerifiedGatewayActor => ({
  appId,
  buildMarker: `${appId}-build-fixture`,
  principalId,
});

const principal = (overrides: Readonly<Record<string, string>>) =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000001',
    authContextRef: 'api-key:module-call-fixture',
    authenticationNamespaceId: 'order-module-call-fixture',
    authMethod: 'api_key',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: buyerPrincipalId,
    tenantId: '40000000-0000-4000-8000-000000000001',
    ...overrides,
  });

/**
 * A verified scope whose subject is the buyer by default. `verified: false` yields the same fields without
 * Core's provenance, which is what a raw request carrying matching fields looks like.
 */
export const verifiedScope = (
  overrides: Readonly<Record<string, string>> = {},
  options: { readonly actor?: VerifiedGatewayActor; readonly verified?: boolean } = {},
) => {
  const context = { ...principal(overrides), correlationId: 'order-module-call-fixture' };
  return options.verified === false
    ? context
    : trustVerifiedGatewayPrincipalContext(context, 'a'.repeat(64), undefined, options.actor);
};
