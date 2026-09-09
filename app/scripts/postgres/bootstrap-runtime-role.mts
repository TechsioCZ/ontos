import { Effect, Exit, Redacted, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';

class RuntimeRoleBootstrapError extends Schema.TaggedError<RuntimeRoleBootstrapError>()('RuntimeRoleBootstrapError', {
  reason: Schema.String,
}) {}

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const query = <Row extends QueryResultRow = QueryResultRow>(
  client: Client,
  text: string,
  values?: unknown[],
): Effect.Effect<QueryResult<Row>, RuntimeRoleBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new RuntimeRoleBootstrapError({
        reason: `PostgreSQL runtime-role bootstrap query failed: ${String(cause)}`,
      }),
    try: async () => await client.query<Row>(text, values),
  });

const connectAdmin = (connectionString: Redacted.Redacted): Effect.Effect<Client, RuntimeRoleBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new RuntimeRoleBootstrapError({
        reason: `Unable to connect to the administrative PostgreSQL database: ${String(cause)}`,
      }),
    try: async () => {
      const client = new Client({
        connectionString: Redacted.value(connectionString),
      });
      await client.connect();
      return client;
    },
  });

const closeAdmin = (client: Client): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new RuntimeRoleBootstrapError({
        reason: `Unable to close the administrative PostgreSQL connection: ${String(cause)}`,
      }),
    try: async () => await client.end(),
  });

const bootstrapRuntimeRole = (
  client: Client,
  database: string,
  password: Redacted.Redacted,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* bootstrapRuntimeRoleEffect() {
    yield* query(client, 'begin');
    const exists = yield* query<{ exists: boolean }>(
      client,
      'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
      ['ontos_runtime'],
    );
    const passwordLiteral = quoteLiteral(Redacted.value(password));
    yield* query(
      client,
      exists.rows[0]?.exists
        ? `alter role ontos_runtime login password ${passwordLiteral} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
        : `create role ontos_runtime login password ${passwordLiteral} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
    );
    yield* query(client, `grant connect on database ${quoteIdentifier(database)} to ontos_runtime`);
    yield* Effect.forEach(
      ['core', 'auth', 'contacts', 'party'],
      (schema) =>
        Effect.gen(function* grantSchemaPrivilegesEffect() {
          const schemaExists = yield* query<{ exists: boolean }>(
            client,
            'select exists(select 1 from pg_catalog.pg_namespace where nspname = $1) as exists',
            [schema],
          );
          if (schemaExists.rows[0]?.exists) {
            yield* query(client, `grant usage on schema ${schema} to ontos_runtime`);
            yield* query(
              client,
              `grant select, insert, update, delete on all tables in schema ${schema} to ontos_runtime`,
            );
            yield* query(client, `grant usage, select on all sequences in schema ${schema} to ontos_runtime`);
            yield* query(
              client,
              `alter default privileges in schema ${schema} grant select, insert, update, delete on tables to ontos_runtime`,
            );
            yield* query(
              client,
              `alter default privileges in schema ${schema} grant usage, select on sequences to ontos_runtime`,
            );
          }
        }),
      { concurrency: 1, discard: true },
    );
    const role = yield* query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      client,
      'select rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = $1',
      ['ontos_runtime'],
    );
    const [runtimeRole] = role.rows;
    if (runtimeRole === undefined || runtimeRole.rolsuper || runtimeRole.rolbypassrls) {
      yield* new RuntimeRoleBootstrapError({
        reason: 'Runtime role must be non-superuser and must not bypass RLS',
      });
    }
    yield* query(client, 'commit');
  }).pipe(Effect.tapError(() => query(client, 'rollback')));

const main = Effect.gen(function* mainEffect() {
  const connections = yield* loadDatabaseConnectionPair().pipe(
    Effect.mapError(
      (failure) =>
        new RuntimeRoleBootstrapError({
          reason: failure.reason,
        }),
    ),
  );
  const password = yield* Effect.try({
    catch: (cause) =>
      new RuntimeRoleBootstrapError({
        reason: `Unable to read the runtime PostgreSQL role credentials: ${String(cause)}`,
      }),
    try: () => new Client({ connectionString: connections.runtime.connectionString }).password,
  });
  if (connections.runtime.user !== 'ontos_runtime') {
    yield* new RuntimeRoleBootstrapError({
      reason: 'DATABASE_URL must use the configured ontos_runtime login',
    });
  }
  const redactedPassword =
    password === undefined || password.length === 0
      ? yield* new RuntimeRoleBootstrapError({
          reason: 'DATABASE_URL must use the configured ontos_runtime login',
        })
      : Redacted.make(password);
  yield* Effect.acquireUseRelease(
    connectAdmin(Redacted.make(connections.admin.connectionString)),
    (client) => bootstrapRuntimeRole(client, connections.admin.database, redactedPassword),
    closeAdmin,
  );
  yield* Effect.sync(() => console.log('Verified least-privilege PostgreSQL role ontos_runtime'));
}).pipe(Effect.tapError((failure) => Effect.logError(failure.reason)));

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
