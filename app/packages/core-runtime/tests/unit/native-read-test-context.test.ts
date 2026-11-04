import { Effect, Layer, Redacted } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';

import { makeNativeReadTestContext } from '../../src/testing/native-reads.ts';

// Deliberately misleading metadata: the fixture must reparse the actual URLs.
const connections = (admin: string, runtime: string) => ({
  admin: {
    connectionString: Redacted.make(admin),
    database: 'ontos_test_party_gateway_fake',
    host: 'localhost',
    port: 5432,
    user: 'admin',
  },
  runtime: {
    connectionString: Redacted.make(runtime),
    database: 'ontos_test_party_gateway_fake',
    host: 'localhost',
    port: 5432,
    user: 'runtime',
  },
});

it.effect('rejects remote, mismatched and non-isolated fixture URLs before database or authorization I/O', () =>
  Effect.scoped(
    Effect.gen(function* rejectsUnsafeFixtureConnections() {
      const context = yield* Layer.build(NodeCrypto.layer);
      const safe = 'postgres://admin:unit@localhost:5432/ontos_test_party_gateway_unit';
      for (const pair of [
        connections('postgres://admin:unit@localhost:5432/current', 'postgres://runtime:unit@localhost:5432/current'),
        connections(
          'postgres://admin:unit@remote.invalid:5432/ontos_test_party_gateway_unit',
          'postgres://runtime:unit@remote.invalid:5432/ontos_test_party_gateway_unit',
        ),
        connections(safe, 'postgres://runtime:unit@127.0.0.1:5432/ontos_test_party_gateway_unit'),
        connections(safe, 'postgres://runtime:unit@localhost:5433/ontos_test_party_gateway_unit'),
        connections(safe, 'postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_other'),
        ...[
          'host=remote.invalid',
          'host=%2Ftmp%2Fsocket',
          'port=5433',
          'user=postgres',
          'password=override',
          'database=current',
          'service=external',
          'options=-csearch_path%3Dpublic',
          '%68ost=remote.invalid',
          'sslmode=require',
          'sslcert=%2Ftmp%2Fnever-read-fixture.pem',
        ].flatMap((query) => [
          connections(`${safe}?${query}`, 'postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_unit'),
          connections(safe, `postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_unit?${query}`),
        ]),
      ]) {
        const error = yield* Effect.flip(
          Effect.scoped(
            makeNativeReadTestContext({
              connections: pair,
              contextPermissions: [],
              moduleId: 'privacy.core',
              ownerFixtureRetention: 'retain-complete-context',
            }).pipe(Effect.provideContext(context)),
          ),
        );
        expect(error).toMatchObject({
          code: 'native_read_test_failed',
          reason: 'Native Read fixture overrides require one isolated localhost database',
        });
      }
    }),
  ),
);

it.effect('reparses administrative identity instead of trusting supplied connection metadata', () =>
  Effect.scoped(
    Effect.gen(function* rejectsAdministrativeRuntimeIdentity() {
      const context = yield* Layer.build(NodeCrypto.layer);
      const error = yield* Effect.flip(
        Effect.scoped(
          makeNativeReadTestContext({
            connections: connections(
              'postgres://same:unit@localhost:5432/ontos_test_party_gateway_unit',
              'postgres://same:other@localhost:5432/ontos_test_party_gateway_unit',
            ),
            contextPermissions: [],
            moduleId: 'privacy.core',
            ownerFixtureRetention: 'retain-complete-context',
          }).pipe(Effect.provideContext(context)),
        ),
      );
      expect(error).toMatchObject({
        code: 'native_read_test_failed',
        reason: 'Native Read isolated database configuration failed',
      });
    }),
  ),
);
