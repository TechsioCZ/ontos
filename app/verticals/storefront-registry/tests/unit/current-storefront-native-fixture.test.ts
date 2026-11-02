import {
  ApplicationCompositionBackendSchema,
  DatabaseConfig,
  parseDatabaseConfig,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto, NodePath } from '@effect/platform-node';
import { DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import {
  CurrentStorefrontNativeFixtureError,
  makeCurrentStorefrontNativeFixture,
  makeCurrentStorefrontNativeReceiver,
} from '../fixtures/current-storefront-native.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '11111111-1111-4111-8111-111111111111',
  authContextRef: 'session:registry-component',
  authMethod: 'session',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
});
const publicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const makeFixture = Effect.fn('RegistryComponentTest.make')(function* makeFixture(
  compositionRevision = 'a'.repeat(64),
) {
  // Public RFC8032 test1 verification material only. These boundary units never sign an assertion.
  const publicKey = yield* Schema.decodeEffect(publicKeySchema)({
    crv: 'Ed25519',
    kty: 'OKP',
    x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  });
  const publicJwks = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(publicKeySchema) })),
  )({ keys: [publicKey] });
  const actions = yield* makeActionTestHarness();
  const reads = yield* makeReadTestHarness({
    compositionRevision,
    executeOwnerQuery: () => Effect.die('Invalid fixture requests cannot execute owner SQL'),
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    scope: { ...principal, correlationId: 'registry-component' },
  });
  const harness = yield* Layer.build(Layer.merge(actions.layer, reads.layer));
  return yield* makeCurrentStorefrontNativeFixture({
    compositionRevision,
    compositionSourceUrl: 'http://127.0.0.1:1/composition',
    issuer: 'https://shell.component.test',
    principal,
    publicJwks,
    storefrontAppId: 'shop-cz',
  }).pipe(
    Effect.provideContext(harness),
    Effect.provideService(
      DatabaseConfig,
      yield* parseDatabaseConfig({
        DATABASE_URL: 'postgresql://runtime:fixture@localhost:1/ontos_test_party_gateway_component',
      }),
    ),
  );
});

it.layer(Layer.merge(NodeCrypto.layer, NodePath.layer))('scoped Registry fixture boundaries', (test) => {
  test.effect('rejects invalid immutable composition before constructing the receiving runtime', () =>
    Effect.scoped(
      Effect.gen(function* invalidComposition() {
        const failure = yield* makeFixture('invalid').pipe(Effect.flip);
        expect(failure).toBeInstanceOf(CurrentStorefrontNativeFixtureError);
      }),
    ),
  );
  test.effect('exposes only bounded operations and rejects another registration identity before any Action', () =>
    Effect.scoped(
      Effect.gen(function* boundedFixtureApi() {
        const fixture = yield* makeFixture();
        expect(Object.keys(fixture).toSorted()).toEqual(['dispatch', 'register']);
        const failure = yield* fixture
          .register({
            allowedChannels: ['B2C'],
            effectiveInterval: { effectiveFrom: '2026-01-01T00:00:00.000Z' },
            lifecycle: 'ACTIVE',
            reason: 'component boundary control',
            storefrontAppId: 'another-shop',
          })
          .pipe(Effect.flip);
        expect(failure).toBeInstanceOf(CurrentStorefrontNativeFixtureError);
      }),
    ),
  );
  test.effect('retains closed scope state and refuses a dispatch after disposal', () =>
    Effect.gen(function* disposedFixture() {
      const fixture = yield* Effect.scoped(makeFixture());
      const failure = yield* fixture.dispatch(new Request('http://registry.component.test/')).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CurrentStorefrontNativeFixtureError);
    }),
  );

  test.effect('refuses receiver activation after its owning scope is disposed', () =>
    Effect.gen(function* disposedReceiver() {
      const receiver = yield* Effect.scoped(makeCurrentStorefrontNativeReceiver());
      const actions = yield* makeActionTestHarness();
      const reads = yield* makeReadTestHarness({
        compositionRevision: 'a'.repeat(64),
        executeOwnerQuery: () => Effect.die('Disposed receiver cannot execute owner SQL'),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        scope: { ...principal, correlationId: 'registry-disposed' },
      });
      const harness = yield* Layer.build(Layer.merge(actions.layer, reads.layer));
      const failure = yield* receiver
        .activate({
          compositionRevision: 'a'.repeat(64),
          compositionSourceUrl: 'http://127.0.0.1:1/composition',
          issuer: 'https://shell.component.test',
          principal,
          publicJwks: '{"keys":[]}',
          storefrontAppId: 'shop-cz',
        })
        .pipe(Effect.provideContext(harness), Effect.flip);
      expect(failure).toBeInstanceOf(CurrentStorefrontNativeFixtureError);
    }),
  );

  test.effect('refuses receiver migration after disposal before requesting filesystem or process services', () =>
    Effect.gen(function* disposedReceiverMigration() {
      const receiver = yield* Effect.scoped(makeCurrentStorefrontNativeReceiver());
      const failure = yield* receiver
        .migrate({
          adminConnectionString: Redacted.make(
            'postgresql://administrator:fixture@localhost/ontos_test_party_gateway_component',
          ),
          runtimeConnectionString: Redacted.make(
            'postgresql://runtime:fixture@localhost/ontos_test_party_gateway_component',
          ),
        })
        .pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              makeTempDirectoryScoped: () => Effect.die('Disposed receiver cannot request filesystem work'),
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die('Disposed receiver cannot spawn a process')),
          ),
          Effect.flip,
        );
      expect(failure).toBeInstanceOf(CurrentStorefrontNativeFixtureError);
    }),
  );

  test.effect('publishes the actual receiving address as a canonical node-http composition backend', () =>
    Effect.scoped(
      Effect.gen(function* canonicalReceivingBackend() {
        const receiver = yield* makeCurrentStorefrontNativeReceiver();
        const backend = { baseUrl: receiver.baseUrl, transport: 'node-http' as const };
        expect(yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)(backend)).toEqual(backend);
        const credentialed = new URL(receiver.baseUrl);
        credentialed.username = 'fixture';
        for (const baseUrl of [
          receiver.baseUrl.slice(0, -1),
          `${receiver.baseUrl}private`,
          `${receiver.baseUrl}?unexpected=true`,
          `${receiver.baseUrl}#fragment`,
          credentialed.href,
          'http://example.com/',
        ]) {
          expect(Schema.is(ApplicationCompositionBackendSchema)({ ...backend, baseUrl })).toBe(false);
        }
      }),
    ),
  );
});
