import { ConfigProvider, Duration, Effect, Redacted, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { DEFAULT_DATABASE_POOL_DEADLINES, configureDatabasePool } from '../../src/db/pool-configuration.ts';

const runtimeUrl = 'postgresql://runtime:secret@localhost:5432/ontos';

it.effect('uses connect and statement deadlines without opting into a lock deadline', () =>
  Effect.gen(function* verifyDefaults() {
    const connectionString = Redacted.make(`${runtimeUrl}?sslmode=require`);
    const configuration = yield* configureDatabasePool(connectionString);

    expect(configuration.connectTimeout).toStrictEqual(
      Duration.millis(DEFAULT_DATABASE_POOL_DEADLINES.connectTimeoutMillis),
    );
    expect(configuration.startupParameters).toStrictEqual({
      statement_timeout: `${DEFAULT_DATABASE_POOL_DEADLINES.statement_timeout}ms`,
    });
    expect(configuration.url === undefined ? undefined : Redacted.value(configuration.url)).toBe(
      `${runtimeUrl}?sslmode=require`,
    );
  }),
);

it.effect('includes an explicitly opted-in lock deadline', () =>
  Effect.gen(function* verifyLockDeadline() {
    const connectionString = Redacted.make(runtimeUrl);
    const configuration = yield* configureDatabasePool(connectionString, {
      lock_timeout: 250,
    });

    expect(configuration.startupParameters?.['lock_timeout']).toBe('250ms');
  }),
);

it.effect('rejects URL deadline overrides with a typed configuration failure', () =>
  Effect.forEach(
    [
      'connectTimeoutMillis=1',
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

const withPoolBudget = (environment: Readonly<Record<string, string>>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment));

it.effect('leaves the pool size and idle timeout to the driver without a process budget', () =>
  Effect.gen(function* verifyNoBudget() {
    const configuration = yield* configureDatabasePool(Redacted.make(runtimeUrl), undefined, 2).pipe(
      withPoolBudget({}),
    );
    expect(configuration.maxConnections).toBe(2);
    expect(configuration.idleTimeout).toBeUndefined();
  }),
);

it.effect('bounds every pool by the process budget and closes idle connections early', () =>
  Effect.gen(function* verifyBudget() {
    const budget = withPoolBudget({
      ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS: '10000',
      ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '4',
    });
    const unrequested = yield* configureDatabasePool(Redacted.make(runtimeUrl)).pipe(budget);
    const larger = yield* configureDatabasePool(Redacted.make(runtimeUrl), undefined, 8).pipe(budget);
    const smaller = yield* configureDatabasePool(Redacted.make(runtimeUrl), undefined, 2).pipe(budget);

    expect([unrequested.maxConnections, larger.maxConnections, smaller.maxConnections]).toStrictEqual([4, 4, 2]);
    expect(unrequested.idleTimeout).toStrictEqual(Duration.millis(10_000));
  }),
);

it.effect('rejects a budget that is not a positive integer', () =>
  Effect.forEach(
    [{ ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '0' }, { ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS: 'soon' }],
    (environment) =>
      Effect.gen(function* verifyInvalidBudget() {
        const error = yield* Effect.flip(
          configureDatabasePool(Redacted.make(runtimeUrl)).pipe(withPoolBudget(environment)),
        );
        expect(Predicate.isTagged(error, 'DatabaseConnectionError')).toBe(true);
      }),
  ),
);
