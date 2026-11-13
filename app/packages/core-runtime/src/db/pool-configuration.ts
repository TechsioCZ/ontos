import type { PgClient } from '@effect/sql-pg';
import { Config, Duration, Effect, Option, Redacted } from 'effect';

import { DatabaseConnectionError } from './connection-error.ts';
import { SHARED_RUNTIME_IDENTITY } from './database-identity-data.ts';

export interface DatabasePoolDeadlines {
  /** Bounds each physical connection's transport, TLS negotiation, startup, and authentication. */
  readonly connectTimeoutMillis: number;
  /**
   * Opt-in only. Row and advisory lock waits are designed serialization, so the statement
   * deadline is the single bound on them unless a caller explicitly chooses a shorter lock bound.
   */
  readonly lock_timeout?: number;
  readonly statement_timeout: number;
}

// Runtime work should fail promptly when PostgreSQL is unreachable without cutting off ordinary queries.
export const DEFAULT_DATABASE_POOL_DEADLINES: Readonly<DatabasePoolDeadlines> = Object.freeze({
  connectTimeoutMillis: 5000,
  statement_timeout: 30_000,
});

// PostgreSQL accepts these deadlines from the startup packet and URL `options`; only poolDeadlines may set them.
const REJECTED_URL_PARAMETERS = [
  'connectTimeoutMillis',
  'connectionTimeoutMillis',
  'connect_timeout',
  'lock_timeout',
  'statement_timeout',
  'query_timeout',
  'options',
] as const;

/**
 * Override deadlines only through poolDeadlines, never connection-string parameters.
 * URL startup options are unsupported because PostgreSQL can use them to override deadlines.
 * Other URL settings, including SSL, are parsed by the native driver unchanged.
 */
/**
 * One host process serves every owner, and each owner opens several pools, so the process environment bounds every
 * pool: `ONTOS_DATABASE_POOL_MAX_CONNECTIONS` caps its connections and `ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS`
 * closes idle ones soon. `ONTOS_DATABASE_POOL_SHARED=true` lets every owner in the process draw from one pool per
 * configuration (`openDatabaseClient`), so a process holds at most the cap per database role, however many owners
 * it serves, keeping two overlapping releases inside the server's connection slots.
 *
 * `ONTOS_DATABASE_POOL_MIN_CONNECTIONS` (default 0) keeps that many connections of the process-shared runtime-role
 * pool open past the idle timeout, so the first request after a pause skips the TLS handshake. Only that pool keeps
 * them: administrator, other roles' and private sessions stay at 0. It may not exceed the cap, so the cap stays the
 * ceiling.
 */
const DatabasePoolBudgetConfig = Config.all({
  idleTimeoutMillis: Config.option(Config.Int('ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS')),
  maxConnections: Config.option(Config.Int('ONTOS_DATABASE_POOL_MAX_CONNECTIONS')),
  minConnections: Config.Int('ONTOS_DATABASE_POOL_MIN_CONNECTIONS').pipe(Config.withDefault(0)),
  processShared: Config.Boolean('ONTOS_DATABASE_POOL_SHARED').pipe(Config.withDefault(false)),
});

/** The native pool settings, and whether owners in this process share the pool these settings describe. */
export interface DatabasePoolConfiguration extends Pick<
  PgClient.PgPoolConfig,
  'connectTimeout' | 'idleTimeout' | 'maxConnections' | 'startupParameters' | 'url'
> {
  /** Connections the pool keeps open while idle; above 0 only for the process-shared runtime-role pool. */
  readonly minConnections: number;
  readonly processShared: boolean;
}

const isPositiveInt32 = (value: number) => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

/** The native pool opens at most ten connections when nothing caps it. */
export const DRIVER_DEFAULT_MAX_CONNECTIONS = 10;

/** The pool's own connection request, bounded by the process budget. */
const budgetedMaxConnections = (requested: number | undefined, budget: Option.Option<number>) =>
  Option.match(budget, {
    onNone: () => requested,
    onSome: (limit) => (requested === undefined ? limit : Math.min(requested, limit)),
  });

export const configureDatabasePool = Effect.fn('PoolConfiguration.configureDatabasePool')(
  function* configureDatabasePool(
    connectionString: Redacted.Redacted,
    poolDeadlines?: Partial<DatabasePoolDeadlines>,
    requestedMaxConnections?: number,
  ): Effect.fn.Return<DatabasePoolConfiguration, DatabaseConnectionError> {
    const budget = yield* DatabasePoolBudgetConfig.pipe(
      Effect.mapError(
        (cause) => new DatabaseConnectionError({ cause, reason: 'Database pool budget settings are malformed' }),
      ),
    );
    if (
      [budget.idleTimeoutMillis, budget.maxConnections].some(
        (setting) => Option.isSome(setting) && !isPositiveInt32(setting.value),
      )
    ) {
      return yield* new DatabaseConnectionError({
        reason: 'Database pool budget settings must be positive 32-bit integers',
      });
    }
    if (
      !Number.isInteger(budget.minConnections) ||
      budget.minConnections < 0 ||
      budget.minConnections > Option.getOrElse(budget.maxConnections, () => DRIVER_DEFAULT_MAX_CONNECTIONS)
    ) {
      return yield* new DatabaseConnectionError({
        reason: 'Database pool minimum connections must be a non-negative integer no larger than the pool maximum',
      });
    }
    const { connectTimeoutMillis, ...serverDeadlines } = { ...DEFAULT_DATABASE_POOL_DEADLINES, ...poolDeadlines };
    for (const value of [connectTimeoutMillis, ...Object.values(serverDeadlines)]) {
      if (value === undefined) {
        continue;
      }
      // PostgreSQL treats zero as disabled; oversized Node timers overflow to 1ms.
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
        return yield* new DatabaseConnectionError({
          reason: 'Database pool deadlines must be positive 32-bit millisecond integers',
        });
      }
    }

    const url = URL.parse(Redacted.value(connectionString));
    if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
      return yield* new DatabaseConnectionError({
        reason: 'Database connection string must be a PostgreSQL URL',
      });
    }

    // Reject rather than strip them, preserving all unrelated URL settings verbatim and keeping one deadline policy.
    if (REJECTED_URL_PARAMETERS.some((key) => url.searchParams.has(key))) {
      return yield* new DatabaseConnectionError({
        reason: 'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
      });
    }

    // Server deadlines belong in every physical connection's startup packet, so PostgreSQL cancels the
    // work itself. Do not race queries against a client timer: that rejects without cancelling server work.
    const startupParameters: Record<string, string> = {};
    for (const [name, value] of Object.entries(serverDeadlines)) {
      if (value !== undefined) {
        startupParameters[name] = `${value}ms`;
      }
    }
    const maxConnections = budgetedMaxConnections(requestedMaxConnections, budget.maxConnections);
    // Every client of the shared runtime role derives the same minimum, so they still meet in one pool.
    const sharedRuntimePool = budget.processShared && decodeURIComponent(url.username) === SHARED_RUNTIME_IDENTITY.role;
    return {
      connectTimeout: Duration.millis(connectTimeoutMillis),
      // Unset values leave the driver defaults (ten connections, a minute of idleness).
      idleTimeout: Option.isSome(budget.idleTimeoutMillis)
        ? Duration.millis(budget.idleTimeoutMillis.value)
        : undefined,
      maxConnections,
      // A pool asking for fewer connections than the minimum keeps all of them warm, never more than it may open.
      minConnections: sharedRuntimePool
        ? Math.min(budget.minConnections, maxConnections ?? DRIVER_DEFAULT_MAX_CONNECTIONS)
        : 0,
      processShared: budget.processShared,
      startupParameters,
      url: connectionString,
    };
  },
);
