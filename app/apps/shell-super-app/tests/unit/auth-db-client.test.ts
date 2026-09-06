import { expect, test } from '@rstest/core';
import { Effect, Redacted } from 'effect';
import type { Pool, PoolConfig } from 'pg';
import type { AuthConfigValue } from '../../api/auth/config.ts';
import { acquirePoolResource, makeAuthDatabase } from '../../api/auth/db/client.ts';

const rawConnectionString = 'postgresql://auth_user:synthetic_password@localhost:5433/ontos';

const authConfiguration: AuthConfigValue = {
  baseUrl: 'http://localhost:3020',
  connectionString: Redacted.make(rawConnectionString),
  secret: Redacted.make('a-secure-test-secret-with-more-than-32-characters'),
  secureCookies: false,
  supportUserIds: [],
  trustedOrigins: ['http://localhost:3020'],
};

const makePool = (end: () => Promise<void>): Pool => ({ end }) as unknown as Pool;

test('forwards the core PostgreSQL pool defaults to the auth pool factory', async () => {
  let received: PoolConfig | undefined;

  await Effect.runPromise(
    Effect.scoped(
      makeAuthDatabase(authConfiguration, (configuration) => {
        received = configuration;
        return makePool(async () => {});
      }),
    ),
  );

  expect(received).toEqual({
    connectionString: rawConnectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
});

test('rejects unsafe URI options before acquiring the auth pool', async () => {
  const connectionString = `${rawConnectionString}?statement_timeout=1&options=-c%20lock_timeout%3D1s`;
  let acquired = false;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        makeAuthDatabase(
          { ...authConfiguration, connectionString: Redacted.make(connectionString) },
          () => {
            acquired = true;
            return makePool(async () => {});
          },
        ),
      ),
    ),
  );

  expect(acquired).toBe(false);
  expect(error._tag).toBe('AuthDatabaseConnectionError');
  expect(error.reason).toMatch(/^Unable to initialize the authentication PostgreSQL pool: .+/u);
  expect(error.reason).not.toContain(connectionString);
});

test('finalizes the auth pool when its Effect scope closes', async () => {
  let finalized = false;

  await Effect.runPromise(
    Effect.scoped(
      acquirePoolResource(() =>
        makePool(async () => {
          finalized = true;
        }),
      ),
    ),
  );

  expect(finalized).toBe(true);
});
