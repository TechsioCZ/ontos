/// <reference types="node" />

import { NodeFileSystem } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Console, Effect, Exit, Match, Redacted, Schema } from 'effect';
import type { FileSystem } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { APP_ENV_PATH } from '../../packages/core-runtime/src/environment/workspace-environment.ts';
import { parseSpiceDbDatabaseBootstrapConfig } from '../../packages/core-runtime/src/install/spicedb-database-config.ts';
import type { SpiceDbDatabaseBootstrapConfig } from '../../packages/core-runtime/src/install/spicedb-database-config.ts';

class SpiceDbDatabaseBootstrapError extends Schema.TaggedError<SpiceDbDatabaseBootstrapError>()(
  'SpiceDbDatabaseBootstrapError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {}

const bootstrapFailure = (reason: string, cause?: unknown): SpiceDbDatabaseBootstrapError =>
  new SpiceDbDatabaseBootstrapError(cause === undefined ? { reason } : { cause, reason });

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const query = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  values?: readonly string[],
): Effect.Effect<readonly Row[], SpiceDbDatabaseBootstrapError> =>
  client
    .unsafe<Row>(text, values)
    .pipe(Effect.mapError((cause) => bootstrapFailure('SpiceDB PostgreSQL bootstrap query failed', cause)));

const loadRootConfiguration = (): Effect.Effect<
  SpiceDbDatabaseBootstrapConfig,
  SpiceDbDatabaseBootstrapError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* loadRootConfigurationEffect() {
    const fileProvider = yield* ConfigProvider.fromDotEnv({
      path: APP_ENV_PATH,
      preserveEmptyStrings: true,
    }).pipe(
      Effect.catchTag('PlatformError', (failure) =>
        Match.value(failure.reason).pipe(
          Match.tag('NotFound', () => Effect.succeed(ConfigProvider.fromUnknown({}, { preserveEmptyStrings: true }))),
          Match.orElse(() => Effect.fail(failure)),
        ),
      ),
      Effect.mapError((cause) => bootstrapFailure(`Unable to load the root environment from ${APP_ENV_PATH}`, cause)),
    );

    const provider = ConfigProvider.orElse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }), fileProvider);
    const [adminUrl, spiceDbUrl] = yield* Effect.all(
      [Config.Redacted('DATABASE_ADMIN_URL').parse(provider), Config.Redacted('SPICEDB_DATABASE_URL').parse(provider)],
      { concurrency: 1 },
    ).pipe(
      Effect.mapError((cause) => bootstrapFailure('SpiceDB PostgreSQL bootstrap configuration is invalid', cause)),
    );

    return yield* Effect.try({
      catch: (cause) => bootstrapFailure('SpiceDB PostgreSQL bootstrap configuration is invalid', cause),
      try: () =>
        parseSpiceDbDatabaseBootstrapConfig({
          DATABASE_ADMIN_URL: Redacted.value(adminUrl),
          SPICEDB_DATABASE_URL: Redacted.value(spiceDbUrl),
        }),
    });
  });

const connectAdmin = (connectionString: Redacted.Redacted) =>
  PgClient.makeClient({ url: connectionString }).pipe(
    Effect.mapError((cause) => bootstrapFailure('Unable to connect to the administrative PostgreSQL database', cause)),
  );

const bootstrapDatabase = (
  client: PgClient.PgClient,
  configuration: SpiceDbDatabaseBootstrapConfig,
): Effect.Effect<void, SpiceDbDatabaseBootstrapError> =>
  Effect.gen(function* bootstrapDatabaseEffect() {
    const role = yield* query<{ exists: boolean }>(
      client,
      'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
      [configuration.user],
    );
    const password = quoteLiteral(configuration.password);
    yield* query(
      client,
      (role[0]?.exists ?? false)
        ? `alter role spicedb login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
        : `create role spicedb login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
    );

    const database = yield* query<{ owner: string }>(
      client,
      `select pg_catalog.pg_get_userbyid(datdba) as owner
       from pg_catalog.pg_database
       where datname = $1`,
      [configuration.database],
    );
    if (database.length === 0) {
      yield* query(client, 'create database spicedb owner spicedb');
    } else if (database[0]?.owner !== configuration.user) {
      yield* bootstrapFailure('Existing spicedb database must be owned by the spicedb role');
    }
  });

const main = Effect.gen(function* mainEffect() {
  const configuration = yield* loadRootConfiguration();
  const client = yield* connectAdmin(Redacted.make(configuration.adminUrl));
  yield* bootstrapDatabase(client, configuration);
  yield* Console.log('Verified least-privilege PostgreSQL database and role for SpiceDB');
}).pipe(
  Effect.scoped,
  Effect.tapError((failure) => Console.error(failure.reason)),
);

const exit = await Effect.runPromiseExit(
  main.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Reactivity.layer)),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
