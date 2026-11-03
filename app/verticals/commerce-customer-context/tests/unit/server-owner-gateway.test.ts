import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { GatewayRelaySourceError } from '@app/shared-contracts/gateway-context-server';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { acquireOwnerGatewayContext } from '../../src/integrations/server-owner-gateway.ts';

const original = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:owner-relay-unit',
    authMethod: 'session',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
  }),
  audience: 'commerce-customer-context',
  correlationId: 'owner-relay-unit',
};
const target = { audience: 'party-registry', operationKey: 'party.registry.api.party-detail' };

it.effect('rejects shape-valid source identity without redeemed admission provenance', () =>
  Effect.gen(function* rejectUnverified() {
    const crypto = yield* Crypto.Crypto;
    const failure = yield* Effect.flip(acquireOwnerGatewayContext(original, crypto, target));
    expect(Schema.is(GatewayRelaySourceError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'Verified owner admission is required' });
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('does not treat copied principal fields as the original admitted operation', () =>
  Effect.gen(function* rejectCopy() {
    const crypto = yield* Crypto.Crypto;
    const verified = trustVerifiedGatewayPrincipalContext(original, 'b'.repeat(64), {
      assertion: Redacted.make('test-source-proof'),
      audience: 'commerce-customer-context',
    });
    const failure = yield* Effect.flip(acquireOwnerGatewayContext({ ...verified }, crypto, target));
    expect(Schema.is(GatewayRelaySourceError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'Verified owner admission is required' });
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('rejects an admitted source proof belonging to another owner', () =>
  Effect.gen(function* rejectOtherOwner() {
    const crypto = yield* Crypto.Crypto;
    const verified = trustVerifiedGatewayPrincipalContext(original, 'b'.repeat(64), {
      assertion: Redacted.make('test-other-owner-proof'),
      audience: 'commerce-market-catalog',
    });
    const failure = yield* Effect.flip(acquireOwnerGatewayContext(verified, crypto, target));
    expect(Schema.is(GatewayRelaySourceError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'Verified owner admission is required' });
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
