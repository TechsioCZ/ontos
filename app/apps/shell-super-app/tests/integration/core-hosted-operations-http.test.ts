import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { exportJWK, generateKeyPair } from 'jose';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The Shell endpoint that hosts Core Media Current V1 for a module (#1443 P2), through the composition `api/index.ts`
 * builds for production, over a real case database and the real access gate. It proves what a session cannot reach:
 * the route is mounted, its dependencies compose (verifier, redemption store, object store, read runtime), and every
 * request that is not a module's audience-scoped Bearer assertion is refused before any read runs, with a sanitized
 * problem. The positive path (a real issued assertion, a real redemption and the read itself) is proven by the
 * receiver unit suite and by the Current read against real PostgreSQL and SpiceDB in core-runtime.
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

const shellHandlerFor = Effect.fn('CoreHostedOperationsHttp.handler')(function* shellHandler(
  accessCase: AccessAdminCase,
  environment: Readonly<Record<string, string>>,
) {
  const originalProvider = yield* ConfigProvider.ConfigProvider;
  const [authentication, issuer, moduleStates] = shellProductionRuntimeArguments;
  const runtime = makeShellAuthenticationApiRuntime(
    authentication,
    issuer,
    moduleStates,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
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

const request = (handler: Effect.Success<ReturnType<typeof shellHandlerFor>>, headers: Record<string, string>) =>
  Effect.tryPromise({
    catch: () => new HostedHttpFixtureFailure({ reason: 'POST asset-current did not answer' }),
    try: async () => {
      const response = await handler.handler(
        new Request(`http://shell.test${assetCurrentPath}`, {
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
      return { status: response.status, text: await response.text() };
    },
  });

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
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
  },
);
