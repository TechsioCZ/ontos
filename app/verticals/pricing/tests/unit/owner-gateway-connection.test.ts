import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  readVerifiedGatewayScopeAssertion,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import { ConfigProvider, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import {
  acquireOwnerGatewayConnection,
  ownerConnectionForComposition,
  ownerCredentialIsLive,
} from '../../src/integrations/owner-gateway-connection.ts';

const revision = 'a'.repeat(64);
const issued = {
  apiBaseUrl: 'https://commerce.internal.example/',
  compositionRevision: revision,
  credential: Redacted.make('Bearer owner-token'),
};

const verifiedScope = () =>
  trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '33333333-3333-4333-8333-333333333333',
        authContextRef: 'session:owner-connection-test',
        authMethod: 'session',
        legalEntityId: '22222222-2222-4222-8222-222222222222',
        principalId: '11111111-1111-4111-8111-111111111111',
        tenantId: '44444444-4444-4444-8444-444444444444',
      }),
      correlationId: 'correlation-owner-connection',
    },
    revision,
    { assertion: Redacted.make('verified-source-assertion'), audience: 'commerce-pricing' },
  );

const shellConfiguration = Layer.merge(
  ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.internal.example/' })),
  // Pricing holds its own key, so a refusal below comes from the copied scope and not from a missing credential.
  Layer.effectDiscard(holdTestModuleCredentials({ pricing: 'module-key' })),
);

it.effect('returns the owner connection when the credential belongs to the active composition', () =>
  Effect.gen(function* allowsActiveComposition() {
    const connection = yield* ownerConnectionForComposition(issued, revision);
    expect(connection.baseUrl.toString()).toBe('https://commerce.internal.example/');
    expect(Redacted.value(connection.credential)).toBe('Bearer owner-token');
  }),
);

it('treats an owner credential as live only before the Shell expiry instant', () => {
  const now = DateTime.makeUnsafe('2026-10-24T12:00:00.000Z');
  const expiry = Math.floor(DateTime.toEpochMillis(now) / 1000);
  expect(ownerCredentialIsLive(expiry + 1, now)).toBe(true);
  expect(ownerCredentialIsLive(expiry, now)).toBe(false);
  expect(ownerCredentialIsLive(expiry - 1, now)).toBe(false);
});

it.effect('refuses a credential issued under a different composition revision', () =>
  Effect.gen(function* deniesOtherComposition() {
    const failure = yield* ownerConnectionForComposition(issued, 'b'.repeat(64)).pipe(Effect.flip);
    expect(failure.reason).toBe('Owner credential belongs to a different active composition');
  }),
);

it.layer(Layer.mergeAll(NodeCrypto.layer, shellConfiguration))('owner connection acquisition', (suite) => {
  suite.effect('keeps the verified gateway provenance on the scope object and loses it on a copy', () =>
    Effect.sync(() => {
      const scope = verifiedScope();
      expect(readVerifiedGatewayScopeAssertion(scope)?.audience).toBe('commerce-pricing');
      expect(readVerifiedGatewayScopeAssertion({ ...scope })).toBeUndefined();
    }),
  );

  suite.effect('fails when a spread copy of the verified scope reaches the owner connection', () =>
    Effect.gen(function* deniesCopiedScope() {
      const crypto = yield* Crypto.Crypto;
      const copied = { ...verifiedScope() };
      const failure = yield* acquireOwnerGatewayConnection(
        {
          audience: 'commerce-order',
          compositionRevision: revision,
          legalEntityScope: 'subject',
          requestCorrelation: 'correlation-owner-connection',
          scope: copied,
        },
        crypto,
      ).pipe(Effect.flip);
      expect(failure.reason).toBe('Owner gateway is unavailable');
      expect(Schema.is(GatewayDelegationSourceError)(failure.cause)).toBe(true);
      expect(Schema.is(GatewayDelegationSourceError)(failure.cause) ? failure.cause.reason : undefined).toBe(
        'Verified gateway scope is required to act for the requester',
      );
    }),
  );
});
