import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemption } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import {
  GatewayAssertionReplayError,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  ReadRuntimeLive,
  TenantModuleStateService,
  assetCurrentRead,
  assetMetadataRead,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { ObjectStorage, unconfiguredObjectStorage } from '@app/core-runtime/media/edge';
import { makeTestAccessGateLayers, testAccessSpecOf } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import {
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  makeGatewayPrincipalVerifierLayer,
} from '@app/gateway-principal-verifier/server';
import { ConfigProvider, Effect, Exit, Layer, Predicate, Redacted, Result, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { NodeCrypto } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import {
  authenticateHostedOperationPrincipal,
  coreHostedReadReceiverBindings,
} from '../../api/core-hosted-operations.ts';
import { hostedAssetCurrent } from '../../api/index.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayIssuer, issueGatewayContextAssertion, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import {
  InstalledModuleCatalogUnavailableError,
  ShellInstalledModuleCatalog,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { CoreHostedOperationUnavailableProblemSchema } from '../../shared/core-hosted-operations.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

/*
 * The Shell host as the receiver of a Core operation it hosts for a module (#1443 P2). The assertion is a REAL one,
 * signed by the real issuer for the Shell audience on behalf of a requester, and every refusal below is the real
 * verifier's or the endpoint's own: wrong audience, another key, replay, a person's direct assertion, a module whose
 * release does not declare the operation, and an unavailable catalog.
 */

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const issuer = 'https://shell.example.test';
const issuedAt = 1_700_000_000;
const requester = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:hosted-operation',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
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
const catalogContract = (declaresHosted: boolean, schemaVersion: string) => {
  const catalog = makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' });
  return declaresHosted
    ? {
        ...catalog,
        manifest: {
          ...catalog.manifest,
          requirements: {
            coreCapabilities: [],
            intrinsic: [],
            operations: [{ ...hostedRequirement, provider: { ...hostedRequirement.provider, schemaVersion } }],
            schemaVersion: '1',
          },
        },
      }
    : catalog;
};

const world = Effect.fn('CoreHostedOperationTest.world')(function* world(declaresHosted = true, schemaVersion = '1') {
  yield* TestClock.setTime((issuedAt + 1) * 1000);
  const snapshot = yield* makeCompositionSnapshot([catalogContract(declaresHosted, schemaVersion)]);
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
    ONTOS_GATEWAY_PRIVATE_JWK: jsonText({ ...jwk, d: privateJwk.d }),
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
  const catalogLoads: number[] = [];
  const provideReceiver = <A, E, R>(
    operation: Effect.Effect<A, E, R>,
    options: {
      readonly catalogUnavailable?: boolean;
      readonly otherKey?: boolean;
      readonly staleCatalog?: boolean;
      readonly wrongRelease?: boolean;
    } = {},
  ) =>
    operation.pipe(
      Effect.provideService(GatewayAssertionRedemptionService, redemption),
      Effect.provideService(ShellInstalledModuleCatalog, {
        load: Effect.suspend(() => {
          catalogLoads.push(consumed.length);
          return options.catalogUnavailable === true
            ? Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'private catalog location' }))
            : Effect.succeed({
                ...installed,
                composition:
                  options.staleCatalog === true
                    ? { ...installed.composition, revision: 'f'.repeat(64) }
                    : installed.composition,
                contracts:
                  options.wrongRelease === true
                    ? installed.contracts.map((contract) => ({
                        ...contract,
                        deployment: { ...contract.deployment, buildMarker: 'another-build' },
                      }))
                    : installed.contracts,
              });
        }),
      }),
      Effect.provide(
        makeGatewayPrincipalVerifierLayer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: jsonText({
              keys: [options.otherKey === true ? { ...jwk, x: 'A'.repeat(43) } : jwk],
            }),
          }),
        ),
      ),
      Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))),
    );
  const receive = (token: string, options?: Parameters<typeof provideReceiver>[1]) =>
    provideReceiver(authenticateHostedOperationPrincipal(Redacted.make(`Bearer ${token}`)), options);
  return { catalogLoads, consumed, installed, issue, issueDirect, provideReceiver, receive };
});

it.effect('accepts the requester relayed by an approved module that declares the hosted operation, once', () =>
  Effect.gen(function* accepted() {
    const { consumed, issue, receive } = yield* world();
    const { token } = yield* issue('shell-super-app');
    const { principal } = yield* receive(token);
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
    const { consumed, issue, receive } = yield* world(false);
    const { token } = yield* issue('shell-super-app');
    const refusal = yield* Effect.flip(receive(token));
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(refusal)).toBe(true);
    // The assertion was verified and redeemed, so it cannot be tried again at another endpoint of this audience.
    expect(consumed).toHaveLength(1);
  }),
);

it.effect('binds the original Current read only for an exact requester-relaying requirement', () =>
  Effect.gen(function* exactCurrent() {
    const { installed } = yield* world();
    const binding = coreHostedReadReceiverBindings(installed);
    expect(binding.actorFor(assetCurrentRead)).toMatchObject({ callers: ['catalog'], subject: 'rights' });
    expect(binding.actorFor(assetMetadataRead)).toBeUndefined();
    expect(binding.actorFor(new Proxy(assetCurrentRead, {}))).toBeUndefined();
    expect(assetCurrentRead.descriptor.accessActor?.callers).toEqual([]);

    const wrongVersion = yield* world(true, '2');
    expect(coreHostedReadReceiverBindings(wrongVersion.installed).actorFor(assetCurrentRead)).toBeUndefined();
    const { token } = yield* wrongVersion.issue('shell-super-app');
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(yield* Effect.flip(wrongVersion.receive(token)))).toBe(true);
  }),
);

it.effect('refuses a different installed caller release or composition after assertion redemption', () =>
  Effect.gen(function* staleAuthority() {
    for (const options of [{ wrongRelease: true }, { staleCatalog: true }]) {
      const { consumed, issue, receive } = yield* world();
      const { token } = yield* issue('shell-super-app');
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(yield* Effect.flip(receive(token, options)))).toBe(true);
      expect(consumed).toHaveLength(1);
    }
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

const currentPayload = Schema.decodeUnknownSync(assetCurrentRead.descriptor.inputSchema)({
  mediaAssetRefs: [
    {
      moduleId: 'core.media',
      resourceId: '50000000-0000-4000-8000-000000000002',
      resourceType: 'core.media.asset',
      tenantId: requester.tenantId,
    },
  ],
});

const currentRequest = (headers: HeadersInit) => {
  const request = HttpServerRequest.fromWeb(
    new Request('http://shell.test/core/operations/asset-current', { headers }),
  );
  return hostedAssetCurrent({ payload: currentPayload, request }).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
  );
};

const withBootReadRuntime = Effect.fn('CoreHostedOperationTest.bootReadRuntime')(function* bootReadRuntime(
  allowed: boolean,
  compositionRevision: string,
) {
  const scope = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(requester);
  const harness = yield* makeReadTestHarness({
    compositionRevision,
    executeOwnerQuery: ({ sql }) => {
      expect(sql).toContain('media_assets');
      return Effect.succeed([]);
    },
    operationTime: new Date(issuedAt * 1000),
    scope: { ...scope, correlationId: 'hosted-current-test' },
  });
  const moduleGateway = ModuleEntrypointGatewayLive.pipe(
    Layer.provide(ModuleStateGateLive),
    Layer.provide(
      Layer.succeed(TenantModuleStateService, {
        getTenantModuleStates: () => Effect.succeed([]),
        listActiveTenantModules: () => Effect.succeed([]),
        listTenantModuleStates: () => Effect.succeed([]),
      }),
    ),
  );
  const decisions: string[] = [];
  const gate = Layer.effect(
    AccessDecisionGate,
    AccessDecisionGate.pipe(
      Effect.map((scripted) => ({
        ...scripted,
        decide: (input) => {
          // A declaration-only test double would let an unbound runtime pass this regression.
          expect(input.carrier.accessActor).toMatchObject({ callers: [moduleActor.appId], subject: 'rights' });
          expect(input.carrier.accessDeclaration?.key).toBe('core.media.asset-current.read');
          expect(readVerifiedGatewayActor(input.scope)).toMatchObject(moduleActor);
          expect(input.scope.principalId).toBe(requester.principalId);
          decisions.push(input.scope.principalId);
          return scripted.decide(input);
        },
      })),
    ),
  ).pipe(
    Layer.provideMerge(
      makeTestAccessGateLayers({
        spec: testAccessSpecOf({ 'core.media.asset-current.read': allowed ? 'allowed' : 'denied' }),
      }),
    ),
  );
  const services = Layer.mergeAll(
    harness.ownerServices,
    gate,
    moduleGateway,
    Layer.succeed(ObjectStorage, unconfiguredObjectStorage),
    staffAuthenticationNamespaceRegistryLayer(['shell-super-app']),
  );
  // Keep the ordinary, unbound instance and its memo map alive around the hosted invocation.
  return { boot: ReadRuntimeLive.pipe(Layer.provideMerge(services)), decisions, harness };
});

it.effect('the hosted handler runs the original Current read with a fresh binding and the requester’s own right', () =>
  Effect.gen(function* hostedCurrentRuntime() {
    for (const allowed of [true, false]) {
      const { catalogLoads, consumed, installed, issue, provideReceiver } = yield* world();
      const { token } = yield* issue('shell-super-app');
      const { boot, decisions, harness } = yield* withBootReadRuntime(allowed, installed.composition.revision);
      const result = yield* provideReceiver(
        currentRequest({
          authorization: `Bearer ${token}`,
          'x-correlation-id': 'hosted-current-test',
        }),
      ).pipe(Effect.provide(boot), Effect.result);
      if (allowed) {
        const context = jsonText({ catalogLoads, trace: harness.snapshot() });
        expect(Result.isSuccess(result), context).toBe(true);
        expect(Result.getOrThrow(result), context).toMatchObject({
          entries: [{ kind: 'ABSENT', resourceRef: currentPayload.mediaAssetRefs[0] }],
        });
        expect(harness.snapshot().ownerQueries).toHaveLength(1);
      } else {
        expect(Result.isFailure(result)).toBe(true);
        const failure = Result.getOrThrow(Result.flip(result));
        expect(Predicate.isTagged(failure, 'CoreHostedOperationForbiddenProblem')).toBe(true);
        expect(failure).toMatchObject({ status: 403 });
        expect(harness.snapshot().ownerQueries).toHaveLength(0);
      }
      expect(catalogLoads).toEqual([1]);
      expect(consumed).toHaveLength(1);
      expect(decisions).toEqual([requester.principalId]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect(
  'rejects invalid correlation and unauthenticated requests without loading the catalog, then sanitizes an outage',
  () =>
    Effect.gen(function* refuseBeforeCatalog() {
      const { catalogLoads, consumed, installed, issue, provideReceiver } = yield* world();
      const { token } = yield* issue('shell-super-app');
      const { boot } = yield* withBootReadRuntime(true, installed.composition.revision);
      const tryRequest = (headers: HeadersInit) =>
        provideReceiver(currentRequest(headers), { catalogUnavailable: true }).pipe(Effect.flip);
      yield* Effect.gen(function* requestOrder() {
        const authorization = `Bearer ${token}`;
        for (const correlation of [
          {},
          { 'x-correlation-id': '   ' },
          { 'x-correlation-id': 'invalid\tcorrelation' },
          { 'x-correlation-id': 'x'.repeat(1024) },
        ]) {
          expect(yield* tryRequest({ ...correlation, authorization })).toMatchObject({ status: 400 });
        }
        expect(yield* tryRequest({ 'x-correlation-id': 'missing' })).toMatchObject({ status: 401 });
        expect(yield* tryRequest({ authorization: 'Bearer malformed', 'x-correlation-id': 'malformed' })).toMatchObject(
          { status: 401 },
        );
        expect(catalogLoads).toEqual([]);
        expect(consumed).toEqual([]);
        const failure = yield* tryRequest({ authorization, 'x-correlation-id': 'authenticated' });
        expect(Schema.is(CoreHostedOperationUnavailableProblemSchema)(failure)).toBe(true);
        expect(failure).toMatchObject({ retryable: true, status: 503 });
        expect(jsonText(failure)).not.toContain('private catalog location');
        expect(catalogLoads).toEqual([1]);
        expect(consumed).toHaveLength(1);
      }).pipe(Effect.provide(boot));
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
