import { loadDatabaseIdentityConnections } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import {
  NativeHumanSessionFixtureError,
  validateNativeHumanSessionConnections,
} from '../support/native-human-sessions.ts';

const database = `action_live_v2_${'a'.repeat(32)}`;
const connectionsFor = (host = '127.0.0.1', name = database) =>
  loadDatabaseIdentityConnections({
    enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT,
    environment: {
      DATABASE_ADMIN_URL: `postgres://native_admin:offline-only@${host}:5432/${name}`,
      ...Object.fromEntries(
        SHELL_DATABASE_IDENTITY_ENROLLMENT.identities.map((identity) => [
          identity.urlKey,
          `postgres://${identity.role}:offline-only@${host}:5432/${name}`,
        ]),
      ),
    },
    envPath: '/dev/null',
  });

it.layer(NodeServices.layer)('native human session connection contract', (suite) => {
  suite.effect('accepts only the supplied isolated database and its enrolled runtime login', () =>
    Effect.gen(function* isolatedConnections() {
      const connections = yield* connectionsFor();
      const runtime = yield* validateNativeHumanSessionConnections(connections);
      expect(runtime).toBe(connections.runtime['shared_runtime']);
      expect(runtime.database).toBe(database);
      expect(runtime.expectedRole).toBe('ontos_runtime');
    }),
  );

  for (const [host, name] of [
    ['database.example.invalid', database],
    ['127.0.0.1', 'existing_application'],
  ]) {
    suite.effect(`refuses non-owned connection ${host}/${name} before any database acquisition`, () =>
      Effect.gen(function* refuseUnownedDatabase() {
        const connections = yield* connectionsFor(host, name);
        expect(
          Schema.is(NativeHumanSessionFixtureError)(
            yield* Effect.flip(validateNativeHumanSessionConnections(connections)),
          ),
        ).toBe(true);
      }),
    );
  }

  suite.effect('refuses an enrolled identity pointing at a different isolated database', () =>
    Effect.gen(function* mixedConnections() {
      const first = yield* connectionsFor();
      const second = yield* connectionsFor('127.0.0.1', `action_live_v2_${'b'.repeat(32)}`);
      expect(
        Schema.is(NativeHumanSessionFixtureError)(
          yield* Effect.flip(validateNativeHumanSessionConnections({ admin: first.admin, runtime: second.runtime })),
        ),
      ).toBe(true);
    }),
  );
});
