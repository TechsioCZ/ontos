import { NodeFileSystem } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, Match, Redacted, Schema } from 'effect';
import type { FileSystem } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

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

const query = <Row extends QueryResultRow = QueryResultRow>(
  client: Client,
  text: string,
  values?: unknown[],
): Effect.Effect<QueryResult<Row>, SpiceDbDatabaseBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) => bootstrapFailure('SpiceDB PostgreSQL bootstrap query failed', cause),
    try: async () => await client.query<Row>(text, values),
  });

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
      [Config.redacted('DATABASE_ADMIN_URL').parse(provider), Config.redacted('SPICEDB_DATABASE_URL').parse(provider)],
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

const connectAdmin = (connectionString: Redacted.Redacted): Effect.Effect<Client, SpiceDbDatabaseBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) => bootstrapFailure('Unable to connect to the administrative PostgreSQL database', cause),
    try: async () => {
      const client = new Client({
        connectionString: Redacted.value(connectionString),
      });
      await client.connect();
      return client;
    },
  });

const closeAdmin = (client: Client): Effect.Effect<void, SpiceDbDatabaseBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) => bootstrapFailure('Unable to close the administrative PostgreSQL connection', cause),
    try: async () => await client.end(),
  });

const bootstrapDatabase = (
  client: Client,
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
      (role.rows[0]?.exists ?? false)
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
    if (database.rows.length === 0) {
      yield* query(client, 'create database spicedb owner spicedb');
    } else if (database.rows[0]?.owner !== configuration.user) {
      yield* bootstrapFailure('Existing spicedb database must be owned by the spicedb role');
    }
  });

const main = Effect.gen(function* mainEffect() {
  const configuration = yield* loadRootConfiguration();
  yield* Effect.acquireUseRelease(
    connectAdmin(Redacted.make(configuration.adminUrl)),
    (client) => bootstrapDatabase(client, configuration),
    closeAdmin,
  );
  yield* Console.log('Verified least-privilege PostgreSQL database and role for SpiceDB');
}).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

const exit = await Effect.runPromiseExit(Effect.provide(main, NodeFileSystem.layer));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
