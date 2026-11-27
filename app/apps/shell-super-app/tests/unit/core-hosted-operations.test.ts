import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemption } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { GatewayAssertionReplayError, makeActiveApplicationCompositionLayer } from '@app/core-runtime';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import {
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  makeGatewayPrincipalVerifierLayer,
} from '@app/gateway-principal-verifier/server';
import { ConfigProvider, Effect, Exit, Layer, Predicate, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import { authenticateHostedOperationPrincipal } from '../../api/core-hosted-operations.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayIssuer, issueGatewayContextAssertion, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import {
  InstalledModuleCatalogUnavailableError,
  ShellInstalledModuleCatalog,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

/*
 * The Shell host as the receiver of a Core operation it hosts for a module (#1443 P2). The assertion is a REAL one,
 * signed by the real issuer for the Shell audience on behalf of a requester, and every refusal below is the real
 * verifier's or the endpoint's own: wrong audience, another key, replay, a person's direct assertion, a module whose
 * release does not declare the operation, and an unavailable catalog.
 */

const issuer = 'https://shell.example.test';
const issuedAt = 1_700_000_000;
const requester = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:hosted-operation',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const moduleActor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
  appId: 'catalog',
  buildMarker: 'catalog-build',
  principalId: '60000000-0000-4000-8000-000000000001',
});

const hostedRequirement = {
  callers: [{ kind: 'person', legalEntityScope: 'subject' }],
  condition: 'commerce.catalog.condition.core-media-current',
  entrypointKey: 'commerce.catalog.api.catalog-document-current',
  evidence: ['core.media.asset'],
  key: 'commerce.catalog.requirement.core-media-current',
  provider: { entrypointKey: 'core.media.api.asset-current', moduleId: 'core.media', schemaVersion: '1' },
};
// The operation this endpoint serves: the exact registration `assetCurrentRead` (provider identity, never a family).
const servedAssetCurrent = {
  entrypointKey: 'core.media.api.asset-current',
  moduleId: 'core.media',
  schemaVersion: '1',
};
const catalogContract = (declared: typeof hostedRequirement | 'nothing') => {
  const catalog = makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' });
  return declared === 'nothing'
    ? catalog
    : {
        ...catalog,
        manifest: {
          ...catalog.manifest,
          requirements: { coreCapabilities: [], intrinsic: [], operations: [declared], schemaVersion: '1' },
        },
      };
};

const world = Effect.fn('CoreHostedOperationTest.world')(function* world(
  declared: typeof hostedRequirement | 'nothing' = hostedRequirement,
) {
  yield* TestClock.setTime((issuedAt + 1) * 1000);
  const snapshot = yield* makeCompositionSnapshot([catalogContract(declared)]);
  const { privateKey } = yield* Effect.promise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
  const jwk = {
    alg: 'EdDSA',
    crv: 'Ed25519',
    kid: 'hosted-test',
    kty: 'OKP',
    use: 'sig',
    x: privateJwk.x ?? '',
  } as const;
  const configuration = yield* parseGatewayIssuerConfig({
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...jwk, d: privateJwk.d }),
  });
  const issuerLayer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(issuedAt),
    generateJti: Effect.succeed('70000000-0000-4000-8000-000000000001'),
    loadAdmission: Effect.succeed({
      audiences: new Map([
        ['catalog', 'catalog-build'],
        ['shell-super-app', ultramodernDeliveryUnit.buildMarker],
      ]),
      revision: snapshot.composition.revision,
    }),
    loadConfig: Effect.succeed(configuration),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  const issue = (audience: string) =>
    Effect.gen(function* issueForModule() {
      const gatewayIssuer = yield* GatewayIssuer;
      return yield* gatewayIssuer.issue({
        actor: moduleActor,
        audience,
        compositionRevision: snapshot.composition.revision,
        principal: requester,
      });
    }).pipe(Effect.provide(issuerLayer));
  // A person's OWN assertion for the Shell audience (no calling module): what a session user may be issued directly.
  const issueDirect = () =>
    issueGatewayContextAssertion({
      audience: 'shell-super-app',
      compositionRevision: snapshot.composition.revision,
      principal: requester,
    }).pipe(Effect.provide(issuerLayer));
  const consumed: string[] = [];
  const redemption: GatewayAssertionRedemption = {
    consume: ({ jti }) =>
      consumed.includes(jti)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'replayed' }))
        : Effect.sync(() => {
            consumed.push(jti);
          }),
  };
  const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const receive = (
    token: string,
    options: {
      readonly catalogUnavailable?: boolean;
      readonly otherKey?: boolean;
      readonly served?: typeof servedAssetCurrent;
    } = {},
  ) =>
    authenticateHostedOperationPrincipal(Redacted.make(`Bearer ${token}`), options.served ?? servedAssetCurrent).pipe(
      Effect.provideService(GatewayAssertionRedemptionService, redemption),
      Effect.provideService(ShellInstalledModuleCatalog, {
        load:
          options.catalogUnavailable === true
            ? Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'controlled' }))
            : Effect.succeed(installed),
      }),
      Effect.provide(
        makeGatewayPrincipalVerifierLayer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
              keys: [options.otherKey === true ? { ...jwk, x: 'A'.repeat(43) } : jwk],
            }),
          }),
        ),
      ),
      Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))),
    );
  return { consumed, issue, issueDirect, receive };
});

it.effect('accepts the requester relayed by an approved module that declares the hosted operation, once', () =>
  Effect.gen(function* accepted() {
    const { consumed, issue, receive } = yield* world();
    const { token } = yield* issue('shell-super-app');
    const principal = yield* receive(token);
    // The read will run as the REQUESTER: the verified principal is theirs, and the module is only the actor.
    expect(principal).toMatchObject({ principalId: requester.principalId, tenantId: requester.tenantId });
    expect(readVerifiedGatewayActor(principal)).toMatchObject(moduleActor);
    expect(consumed).toEqual(['70000000-0000-4000-8000-000000000001']);
    // The very same assertion is spent: replaying it is refused and nothing runs.
    const replay = yield* Effect.flip(receive(token));
    expect(Schema.is(ActionPrincipalInvalidErrorSchema)(replay)).toBe(true);
  }),
);

it.effect(
  'refuses an assertion issued for another audience, signed by another key, or that is not a bearer at all',
  () =>
    Effect.gen(function* wrongAudienceOrKey() {
      const { issue, receive } = yield* world();
      const forVertical = yield* issue('catalog');
      // An assertion for a vertical is not the Shell's: the audience check fails before anything else.
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(yield* Effect.flip(receive(forVertical.token)))).toBe(true);
      const forShell = yield* issue('shell-super-app');
      expect(
        Schema.is(ActionPrincipalInvalidErrorSchema)(yield* Effect.flip(receive(forShell.token, { otherKey: true }))),
      ).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(receive('not-a-token')))).toBe(true);
    }),
);

it.effect('refuses a module whose own installed release does not declare the hosted operation', () =>
  Effect.gen(function* undeclared() {
    const { consumed, issue, receive } = yield* world('nothing');
    const { token } = yield* issue('shell-super-app');
    const refusal = yield* Effect.flip(receive(token));
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(refusal)).toBe(true);
    // The assertion was verified and redeemed, so it cannot be tried again at another endpoint of this audience.
    expect(consumed).toHaveLength(1);
  }),
);

it.effect(
  'would refuse an asset-current declaration at an endpoint serving another operation (no second hosted one exists)',
  () =>
    Effect.gen(function* otherHostedOperation() {
      // The served side is hypothetical: Current is the only Core operation the Shell hosts for modules, and a manifest
      // may name callers for no other. This pins that the check compares the entrypoint, so that a second hosted
      // operation would not be reachable through the declaration of the first.
      const { consumed, issue, receive } = yield* world();
      const { token } = yield* issue('shell-super-app');
      const refusal = yield* Effect.flip(
        receive(token, {
          served: { entrypointKey: 'core.media.api.asset-download', moduleId: 'core.media', schemaVersion: '1' },
        }),
      );
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(refusal)).toBe(true);
      expect(consumed).toHaveLength(1);
    }),
);

it.effect('refuses a module that declares the operation at another schema version than the one served', () =>
  Effect.gen(function* otherSchemaVersion() {
    const { issue, receive } = yield* world({
      ...hostedRequirement,
      provider: { ...hostedRequirement.provider, schemaVersion: '2' },
    });
    const { token } = yield* issue('shell-super-app');
    const refusal = yield* Effect.flip(receive(token));
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(refusal)).toBe(true);
  }),
);

it.effect('answers an unavailable installed catalog as unavailable, never as an allow', () =>
  Effect.gen(function* catalogUnavailable() {
    const { issue, receive } = yield* world();
    const { token } = yield* issue('shell-super-app');
    const failure = yield* Effect.flip(receive(token, { catalogUnavailable: true }));
    expect(Predicate.isTagged(failure, 'ActionPrincipalUnavailableError')).toBe(true);
    expect(Schema.is(ActionPrincipalUnavailableErrorSchema)(failure)).toBe(true);
  }),
);

it.effect(
  "refuses a person's own assertion for the Shell audience: a person reaches Core Media through the session routes",
  () =>
    Effect.gen(function* directAssertion() {
      const { consumed, issueDirect, receive } = yield* world();
      const { token } = yield* issueDirect();
      const refusal = yield* Effect.flip(receive(token));
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(refusal)).toBe(true);
      expect(consumed).toHaveLength(1);
    }),
);
