import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Redacted, Schema } from 'effect';

import { OwnerGatewayConnectionError } from '../../src/integrations/owner-gateway-connection.ts';
import type { OwnerGatewayConnectionAcquire } from '../../src/integrations/owner-gateway-connection.ts';

export const testCompositionRevision = 'a'.repeat(64);

/** A verified scope carries the redeemed gateway assertion; a spread copy of it does not. */
export const verifiedTestScope = (input: {
  readonly correlationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}): OperationalScope =>
  trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '33333333-3333-4333-8333-333333333333',
        authContextRef: 'session:pricing-owner-connection-test',
        authMethod: 'session',
        legalEntityId: input.legalEntityId,
        principalId: input.principalId,
        tenantId: input.tenantId,
      }),
      correlationId: input.correlationId,
    },
    testCompositionRevision,
    { assertion: Redacted.make('verified-source-assertion'), audience: 'commerce-pricing' },
  );

/**
 * Owner connection stub. It admits only a provenance-bearing scope, so a copied scope fails here the same way it
 * fails at the Shell-backed acquisition.
 */
export const ownerConnectionStub =
  (credential: string, baseUrl = 'https://owner.example.test/'): OwnerGatewayConnectionAcquire =>
  (input) =>
    readVerifiedGatewayScopeAssertion(input.scope) === undefined
      ? Effect.fail(new OwnerGatewayConnectionError({ reason: 'Owner gateway is unavailable' }))
      : Effect.succeed({ baseUrl: new URL(baseUrl), credential: Redacted.make(credential) });
