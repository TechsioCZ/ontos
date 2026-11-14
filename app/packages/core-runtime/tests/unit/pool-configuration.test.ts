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

const sharedRuntimeUrl = Redacted.make('postgresql://ontos_runtime:secret@localhost:5432/ontos');

it.effect('keeps no connection warm by default', () =>
  Effect.gen(function* verifyDefaultMinimum() {
    const configuration = yield* configureDatabasePool(sharedRuntimeUrl).pipe(
      withPoolBudget({ ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '6', ONTOS_DATABASE_POOL_SHARED: 'true' }),
    );
    expect(configuration.minConnections).toBe(0);
  }),
);

const minimum = (url: Redacted.Redacted, environment: Readonly<Record<string, string>>, requested?: number) =>
  configureDatabasePool(url, undefined, requested).pipe(
    withPoolBudget(environment),
    Effect.map(({ maxConnections, minConnections }) => ({ maxConnections, minConnections })),
  );

it.effect('keeps the minimum warm only on the process-shared runtime-role pool', () =>
  Effect.gen(function* verifyMinimumScope() {
    const shared = {
      ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '6',
      ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '2',
      ONTOS_DATABASE_POOL_SHARED: 'true',
    };
    expect(yield* minimum(sharedRuntimeUrl, shared)).toStrictEqual({ maxConnections: 6, minConnections: 2 });
    // Owner pools of other roles, the administrator and the gateway issuer keep none.
    for (const role of ['party_registry_runtime', 'ontos_admin', 'shell_gateway_issuer']) {
      const url = Redacted.make(`postgresql://${role}:secret@localhost:5432/ontos`);
      expect((yield* minimum(url, shared)).minConnections).toBe(0);
    }
    // A process that does not share pools would multiply the minimum by every owner client.
    expect((yield* minimum(sharedRuntimeUrl, { ...shared, ONTOS_DATABASE_POOL_SHARED: 'false' })).minConnections).toBe(
      0,
    );
    // A pool asking for fewer connections than the minimum never keeps more than it may open.
    expect(yield* minimum(sharedRuntimeUrl, shared, 1)).toStrictEqual({ maxConnections: 1, minConnections: 1 });
  }),
);

it.effect('fails closed on a minimum that is not a non-negative integer or exceeds the maximum', () =>
  Effect.forEach(
    [
      { ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '-1' },
      { ONTOS_DATABASE_POOL_MIN_CONNECTIONS: 'two' },
      { ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '1.5' },
      { ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '6', ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '7' },
      // Without a cap the driver opens at most ten.
      { ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '11' },
    ],
    (environment) =>
      Effect.gen(function* verifyInvalidMinimum() {
        const error = yield* Effect.flip(
          configureDatabasePool(sharedRuntimeUrl).pipe(
            withPoolBudget({ ...environment, ONTOS_DATABASE_POOL_SHARED: 'true' }),
          ),
        );
        expect(Predicate.isTagged(error, 'DatabaseConnectionError')).toBe(true);
      }),
  ),
);

it.effect('accepts a minimum equal to the maximum', () =>
  Effect.gen(function* verifyMinimumAtCap() {
    const configuration = yield* configureDatabasePool(sharedRuntimeUrl).pipe(
      withPoolBudget({
        ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '6',
        ONTOS_DATABASE_POOL_MIN_CONNECTIONS: '6',
        ONTOS_DATABASE_POOL_SHARED: 'true',
      }),
    );
    expect(configuration.minConnections).toBe(6);
  }),
);
