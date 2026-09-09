import { Effect, Redacted, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { DEFAULT_DATABASE_POOL_DEADLINES, configureDatabasePool } from '../../src/db/pool-configuration.ts';

const runtimeUrl = 'postgresql://runtime:secret@localhost:5432/ontos';

it.effect('uses acquisition and statement deadlines without opting into a lock deadline', () =>
  Effect.gen(function* verifyDefaults() {
    const connectionString = Redacted.make(`${runtimeUrl}?sslmode=require`);
    const configuration = yield* configureDatabasePool(connectionString);

    expect(configuration.connectionTimeoutMillis).toBe(DEFAULT_DATABASE_POOL_DEADLINES.connectionTimeoutMillis);
    expect(configuration.statement_timeout).toBe(DEFAULT_DATABASE_POOL_DEADLINES.statement_timeout);
    expect(Object.hasOwn(configuration, 'lock_timeout')).toBe(false);
    expect(configuration.connectionString).toBe(`${runtimeUrl}?sslmode=require`);
  }),
);

it.effect('includes an explicitly opted-in lock deadline', () =>
  Effect.gen(function* verifyLockDeadline() {
    const connectionString = Redacted.make(runtimeUrl);
    const configuration = yield* configureDatabasePool(connectionString, {
      lock_timeout: 250,
    });

    expect(configuration.lock_timeout).toBe(250);
  }),
);

it.effect('rejects URL deadline overrides with a typed configuration failure', () =>
  Effect.forEach(
    [
      'connectionTimeoutMillis=1',
      'connect_timeout=1',
      'lock_timeout=1',
      'statement_timeout=1',
      'query_timeout=1',
      'options=-c%20statement_timeout%3D1',
    ],
    (parameter) =>
      Effect.gen(function* verifyParameter() {
        const connectionString = Redacted.make(`${runtimeUrl}?${parameter}`);
        const error = yield* Effect.flip(configureDatabasePool(connectionString));
        expect(Predicate.isTagged(error, 'DatabaseConnectionError')).toBe(true);
        expect(error.reason).toBe(
          'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
        );
      }),
    { concurrency: 'unbounded' },
  ),
);

it.effect('rejects invalid deadline values with a typed configuration failure', () =>
  Effect.gen(function* verifyInvalidDeadline() {
    const connectionString = Redacted.make(runtimeUrl);
    const error = yield* Effect.flip(configureDatabasePool(connectionString, { statement_timeout: 0 }));

    expect(Predicate.isTagged(error, 'DatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe('Database pool deadlines must be positive 32-bit millisecond integers');
  }),
);
