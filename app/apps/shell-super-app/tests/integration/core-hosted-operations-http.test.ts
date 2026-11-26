import { DatabaseConfig } from '@app/core-runtime';
import { CoreDatabase, CoreDatabaseLive } from '@app/core-runtime/db/client';
import { makeActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { Clock, ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { exportJWK, generateKeyPair } from 'jose';
import { expect, it } from 'effect-rstest';

import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayIssuer, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

/*
 * The Shell endpoint that hosts Core Media Current V1 for a module (#1443 P2), through the composition `api/index.ts`
 * builds for production, over a real case database and the real access gate. It proves what a session cannot reach:
 * the route is mounted, its dependencies compose (verifier, redemption store, object store, read runtime), and every
 * request that is not a module's audience-scoped Bearer assertion is refused before any read runs, with a sanitized
 * problem. With real signed assertions it proves what the mounted route authenticates against and serves: of two
 * modules in one published release, the one declaring Current at the served schema version is answered by that read
 * and the one declaring another version is refused. The asked id is unknown, so no object store is needed.
 */

class HostedHttpFixtureFailure extends Schema.TaggedError<HostedHttpFixtureFailure>()('HostedHttpFixtureFailure', {
  reason: Schema.String,
}) {}

const { apiPrefix } = shellAuthenticationApiContract;
const assetCurrentPath = `${apiPrefix}/core/operations/asset-current`;
const payload = {
  mediaAssetRefs: [
    {
      moduleId: 'core.media',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceType: 'core.media.asset',
      tenantId: '22222222-2222-4222-8222-222222222222',
    },
  ],
};

/** The active composition and installed modules a case puts in place of the published ones. */
interface InstalledRelease {
  readonly snapshot: Effect.Success<ReturnType<typeof makeCompositionSnapshot>>;
}

const shellHandlerFor = Effect.fn('CoreHostedOperationsHttp.handler')(function* shellHandler(
  accessCase: AccessAdminCase,
  environment: Readonly<Record<string, string>>,
  release?: InstalledRelease,
) {
  const originalProvider = yield* ConfigProvider.ConfigProvider;
  const [authentication, issuer] = shellProductionRuntimeArguments;
  const installed =
    release === undefined ? undefined : yield* makeInstalledModuleCatalogLoader(Effect.succeed(release.snapshot));
  const runtime = makeShellAuthenticationApiRuntime(
    authentication,
    issuer,
    // Module states are read from the case's own database.
    undefined,
    installed === undefined ? undefined : Effect.succeed(installed),
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    release === undefined ? undefined : makeActiveApplicationCompositionService(Effect.succeed(release.snapshot)),
    accessCase.databases,
  );
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new HostedHttpFixtureFailure({ reason: 'The Shell API handler could not be created' }),
      try: async () =>
        await createEffectBffTestHandler({
          module: {
            default: defineEffectBff({
              ...runtime,
              layer: runtime.layer.pipe(
                Layer.provideMerge(
                  ConfigProvider.layer(
                    ConfigProvider.fromEnvRecord(environment).pipe(ConfigProvider.orElse(originalProvider)),
                  ),
                ),
              ),
            }),
          },
          prefix: apiPrefix,
        }),
    }),
    (handler) => Effect.promise(handler.dispose.bind(handler)),
  );
});

const request = (
  handler: Effect.Success<ReturnType<typeof shellHandlerFor>>,
  headers: Record<string, string>,
  body: typeof payload = payload,
) =>
  Effect.tryPromise({
    catch: () => new HostedHttpFixtureFailure({ reason: 'POST asset-current did not answer' }),
    try: async () => {
      const response = await handler.handler(
        new Request(`http://shell.test${assetCurrentPath}`, {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
      return { status: response.status, text: await response.text() };
    },
  });

/**
 * Two modules of one release, each declaring Core Media Current: one at the schema version the Shell serves, one at
 * another. Current V1 is the only Core operation a module may declare with callers, so only the version can differ.
 */
const modules = [
  {
    appId: 'catalog',
    moduleId: 'commerce.catalog',
    principalId: '60000000-0000-4000-8000-000000000001',
    schemaVersion: '1',
  },
  {
    appId: 'assortment',
    moduleId: 'commerce.assortment',
    principalId: '60000000-0000-4000-8000-000000000002',
    schemaVersion: '2',
  },
] as const;
const [declaringServedVersion, declaringOtherVersion] = modules;
const buildMarkerOf = (appId: string) => `${appId}-build`;

const contractOf = ({ appId, moduleId, schemaVersion }: (typeof modules)[number]) => {
  const contract = makeModuleContractFixture({ appId, moduleId });
  const requirement = {
    callers: [{ kind: 'person', legalEntityScope: 'subject' }],
    condition: `${moduleId}.condition.core-media`,
    entrypointKey: `${moduleId}.api.core-media-consumer`,
    evidence: ['core.media.asset'],
    key: `${moduleId}.requirement.core-media`,
    provider: { entrypointKey: 'core.media.api.asset-current', moduleId: 'core.media', schemaVersion },
  };
  return {
    ...contract,
    manifest: {
      ...contract.manifest,
      requirements: { coreCapabilities: [], intrinsic: [], operations: [requirement], schemaVersion: '1' },
    },
  };
};

/** Publishes the release into the case database, as a deployment does: the read runtime admits only that one. */
const publishRelease = Effect.fn('CoreHostedOperationsHttp.publish')(function* publishRelease(
  accessCase: AccessAdminCase,
) {
  const snapshot = yield* makeCompositionSnapshot(modules.map(contractOf));
  const context = yield* Layer.build(
    CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, accessCase.databases.admin))),
  );
  yield* Context.get(context, CoreDatabase).executor.transaction(
    Effect.fn('CoreHostedOperationsHttp.publishInTransaction')(function* publish(transaction) {
      yield* lockApplicationCompositionPublication(transaction);
      return yield* publishApplicationCompositionAuthority(transaction, snapshot);
    }),
  );
  return { snapshot } satisfies InstalledRelease;
});

/** Real issuer-signed assertions for the Shell audience: the case's owner, relayed by the named module. */
const makeOwnerAssertions = Effect.fn('CoreHostedOperationsHttp.assertions')(function* makeOwnerAssertions(
  accessCase: AccessAdminCase,
  release: InstalledRelease,
) {
  const { privateKey, publicKey } = yield* Effect.promise(
    async () => await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
  );
  const [privateJwk, publicJwk] = yield* Effect.promise(
    async () => await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]),
  );
  const key = { alg: 'EdDSA', crv: 'Ed25519', kid: 'hosted-http', kty: 'OKP', use: 'sig', x: publicJwk.x } as const;
  const environment = {
    ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [key] }),
  };
  const configuration = yield* parseGatewayIssuerConfig({
    ONTOS_GATEWAY_ISSUER: environment.ONTOS_GATEWAY_ISSUER,
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...key, d: privateJwk.d }),
  });
  const clock = yield* Clock.Clock;
  const { revision } = release.snapshot.composition;
  const owner = yield* accessCase.scopeFor('owner');
  const issuerLayer = makeGatewayIssuerLayer({
    currentTimeSeconds: clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000))),
    generateJti: Effect.sync(() => globalThis.crypto.randomUUID()),
    loadAdmission: Effect.succeed({
      audiences: new Map([
        ...modules.map(({ appId }) => [appId, buildMarkerOf(appId)] as const),
        ['shell-super-app', ultramodernDeliveryUnit.buildMarker],
      ]),
      revision,
    }),
    loadConfig: Effect.succeed(configuration),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  const relayedBy = Effect.fn('CoreHostedOperationsHttp.issue')(function* issueRelayed({
    appId,
    principalId,
  }: (typeof modules)[number]) {
    const gatewayIssuer = yield* GatewayIssuer;
    const issued = yield* gatewayIssuer.issue({
      actor: yield* Schema.decodeUnknownEffect(GatewayActorClaimSchema)({
        appId,
        buildMarker: buildMarkerOf(appId),
        principalId,
      }),
      audience: 'shell-super-app',
      compositionRevision: revision,
      principal: {
        authBindingId: owner.authBindingId,
        authContextRef: 'better-auth-session:hosted-http',
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        principalId: owner.principalId,
        tenantId: accessCase.tenantId,
      },
    });
    return issued.token;
  }, Effect.provide(issuerLayer));
  return { environment, relayedBy };
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the Shell hosts Core Media Current V1 for a module',
  (suite) => {
    suite.effect(
      'refuses every request that is not a module Bearer assertion, before any read, with a sanitized 401',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* refusedWithoutAssertion() {
              // The verifier is configured (a key it can verify with), so a malformed assertion is a 401, not an outage.
              const { publicKey } = yield* Effect.promise(
                async () => await generateKeyPair('EdDSA', { crv: 'Ed25519' }),
              );
              const jwk = yield* Effect.promise(async () => await exportJWK(publicKey));
              const handler = yield* shellHandlerFor(accessCase, {
                ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
                ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                  keys: [{ alg: 'EdDSA', crv: 'Ed25519', kid: 'hosted-http', kty: 'OKP', use: 'sig', x: jwk.x }],
                }),
              });
              // Like every governed read, the request names its correlation; without it the request is invalid.
              expect((yield* request(handler, {})).status).toBe(400);
              for (const headers of [
                {},
                { authorization: 'Bearer not-a-token' },
                { authorization: 'Basic abc' },
                // A session cookie is not an assertion: this route never reads one.
                { cookie: 'better-auth.session_token=anything' },
                { authorization: 'Bearer a.b.c' },
              ]) {
                const answered = yield* request(handler, { ...headers, 'x-correlation-id': 'hosted-op-test' });
                expect({ status: answered.status, text: answered.text }, JSON.stringify(headers)).toMatchObject({
                  status: 401,
                });
                // The problem carries no assertion, no key, no stack and no storage value.
                expect(answered.text).not.toMatch(/eyJ|stack|storage|credential|secret/iu);
              }
            }),
          ),
        ),
    );

    suite.effect(
      'serves Current V1 to a module that declares the served operation, and 401 to one declaring another version of it',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* declaredOperation() {
              const release = yield* publishRelease(accessCase);
              const { environment, relayedBy } = yield* makeOwnerAssertions(accessCase, release);
              const handler = yield* shellHandlerFor(accessCase, environment, release);
              const asked = {
                mediaAssetRefs: payload.mediaAssetRefs.map((ref) => ({ ...ref, tenantId: accessCase.tenantId })),
              };
              const answerTo = Effect.fn('CoreHostedOperationsHttp.answerTo')(function* answerTo(
                module: (typeof modules)[number],
              ) {
                const token = yield* relayedBy(module);
                return yield* request(
                  handler,
                  { authorization: `Bearer ${token}`, 'x-correlation-id': `hosted-op-${module.appId}` },
                  asked,
                );
              });

              // The module declaring what this path serves: the Current read's own answer for the very ref asked.
              const served = yield* answerTo(declaringServedVersion);
              expect(served.status, served.text).toBe(200);
              expect(JSON.parse(served.text)).toEqual({
                entries: [{ kind: 'ABSENT', resourceRef: asked.mediaAssetRefs[0] }],
              });
              // The same requester, signature and release, but this module declares another version of the operation. The 401
              // is the route's own authentication: the read's later actor rule would answer 403.
              const other = yield* answerTo(declaringOtherVersion);
              expect(other.status, other.text).toBe(401);
            }),
          ),
        ),
    );
  },
);
