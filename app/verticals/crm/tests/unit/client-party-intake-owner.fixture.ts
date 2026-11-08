import { ActiveApplicationCompositionService } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { GatewayAssertionReplayError } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { GATEWAY_ASSERTION_VERSION, GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect } from 'effect-rstest';

import { PartyIntakeLive } from '../../src/services/party-intake.ts';
import { crmRegistration } from '../../vertical.registration.ts';

/** Cryptographically verified original caller and HTTP facts for the actual PartyIntake adapter. */
export const clientIntakeOwnerFixture = Effect.fn('ClientIntakeTest.ownerFixture')(function* ownerFixture(
  principal: TrustedPrincipalContext,
) {
  const owner = yield* makeOwnerApplicationCompositionFixture({ appId: 'crm', ownerRegistration: crmRegistration });
  const { revision } = owner.snapshot.composition;
  const { privateKey, publicKey } = yield* Effect.promise(async () => await generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(exportJWK.bind(undefined, publicKey))),
    alg: 'EdDSA',
    kid: 'intake-unit',
    use: 'sig',
  };
  const issuer = 'https://shell-intake.example.test';
  const unsigned = new SignJWT({
    compositionRevision: revision,
    principal,
    targetBuildMarker: owner.expectedDeployment.buildMarker,
    ver: GATEWAY_ASSERTION_VERSION,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'intake-unit', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('crm')
    .setSubject(principal.principalId)
    .setIssuedAt(1_700_000_000)
    .setExpirationTime(1_700_000_300)
    .setJti('60000000-0000-4000-8000-000000000087');
  const token = yield* Effect.promise(async () => await unsigned.sign(privateKey));
  const redeemed = new Set<string>();
  const verifiedPrincipal = yield* bindGatewayPrincipalVerifier('crm', owner.expectedDeployment)
    .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
      currentTimeSeconds: Effect.succeed(1_700_000_001),
      environment: { ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }) },
      redemption: {
        consume: ({ jti }) =>
          Effect.suspend(() => {
            if (redeemed.has(jti)) {
              return Effect.fail(
                new GatewayAssertionReplayError({ reason: 'The test assertion has already been redeemed' }),
              );
            }
            redeemed.add(jti);
            return Effect.void;
          }),
      },
    })
    .pipe(Effect.provideService(ActiveApplicationCompositionService, owner.applicationComposition));
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const wire = new Request(input, init);
    const path = new URL(wire.url).pathname;
    calls.push(path);
    expect(wire.headers.get('x-correlation-id')).toBe('native-intake');
    if (path === '/auth/delegated/gateway-context') {
      expect(wire.headers.get('x-api-key')).toBe('intake-unit-module-credential');
      const request = Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema)(await wire.json());
      expect(request.compositionRevision).toBe(revision);
      expect(Schema.encodeSync(GatewayDelegatedContextRequestSchema)(request).subject).toEqual({
        _tag: 'Assertion',
        sourceAssertion: token,
      });
      expect(request.audience).toBe('party-registry');
      return Response.json({
        apiBaseUrl: '/party-registry-api',
        compositionRevision: revision,
        expiresAt: 1_700_000_300,
        token: 'intake-unit-registry-assertion',
      });
    }
    if (path === '/party-registry-api/reads/customer-list') {
      expect(await wire.json()).toEqual({ includeArchived: false, limit: 500 });
      expect(wire.headers.get('authorization')).toBe('Bearer intake-unit-registry-assertion');
      expect(wire.headers.get('x-ontos-composition-revision')).toBe(revision);
      return Response.json({
        items: [
          {
            city: null,
            companyId: '12345678',
            counterpartyId: 'registry-customer',
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: 'registry-customer',
              resourceType: 'party.registry.counterparty',
              tenantId: principal.tenantId,
            },
            createdAt: '2026-01-01T00:00:00.000Z',
            displayName: 'Verified customer',
            email: null,
            partyId: 'registry-party',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: 'registry-party',
              resourceType: 'party.registry.party',
              tenantId: principal.tenantId,
            },
            partyRevision: 1,
            phone: null,
            status: 'ACTIVE',
            vatId: null,
          },
        ],
      });
    }
    return Response.json({ reason: 'Unexpected intake owner HTTP request' }, { status: 503 });
  };
  const transport = Layer.mergeAll(
    PartyIntakeLive,
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, fetch),
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_MODULE_API_KEY: 'intake-unit-module-credential',
        ONTOS_SHELL_GATEWAY_BASE_URL: issuer,
      }),
    ),
  );
  return { calls, owner, principal: verifiedPrincipal, transport };
});
