/// <reference types="node" />

import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Predicate, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';

class RuntimeRoleBootstrapError extends Schema.TaggedError<RuntimeRoleBootstrapError>()('RuntimeRoleBootstrapError', {
  reason: Schema.String,
}) {}

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const queryFailure = (cause: SqlError): RuntimeRoleBootstrapError =>
  new RuntimeRoleBootstrapError({
    reason: `PostgreSQL runtime-role bootstrap query failed: ${cause.message}`,
  });

const query = <Row extends object>(
  client: PgClient.PgClient,
  text: string,
  values?: readonly string[],
): Effect.Effect<readonly Row[], RuntimeRoleBootstrapError> =>
  client.unsafe<Row>(text, values).pipe(Effect.mapError(queryFailure));

const connectAdmin = (connectionString: Redacted.Redacted) =>
  PgClient.makeClient({ url: connectionString }).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeRoleBootstrapError({
          reason: `Unable to connect to the administrative PostgreSQL database: ${cause.message}`,
        }),
    ),
  );

const bootstrapRuntimeRole = (
  client: PgClient.PgClient,
  database: string,
  password: Redacted.Redacted,
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* bootstrapRuntimeRoleEffect() {
    const exists = yield* query<{ exists: boolean }>(
      client,
      'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
      ['ontos_runtime'],
    );
    const passwordLiteral = quoteLiteral(Redacted.value(password));
    yield* query(
      client,
      exists[0]?.exists
        ? `alter role ontos_runtime login password ${passwordLiteral} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
        : `create role ontos_runtime login password ${passwordLiteral} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
    );
    yield* query(client, `grant connect on database ${quoteIdentifier(database)} to ontos_runtime`);
    yield* Effect.forEach(
      ['core', 'auth', 'contacts', 'party', 'catalog'],
      (schema) =>
        Effect.gen(function* grantSchemaPrivilegesEffect() {
          const schemaExists = yield* query<{ exists: boolean }>(
            client,
            'select exists(select 1 from pg_catalog.pg_namespace where nspname = $1) as exists',
            [schema],
          );
          if (schemaExists[0]?.exists) {
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
    const [runtimeRole] = role;
    if (runtimeRole === undefined || runtimeRole.rolsuper || runtimeRole.rolbypassrls) {
      yield* new RuntimeRoleBootstrapError({
        reason: 'Runtime role must be non-superuser and must not bypass RLS',
      });
    }
  }).pipe(
    client.withTransaction,
    Effect.mapError((failure) => (Predicate.isTagged(failure, 'SqlError') ? queryFailure(failure) : failure)),
  );

const main = Effect.gen(function* mainEffect() {
  const connections = yield* loadDatabaseConnectionPair().pipe(
    Effect.mapError(
      (failure) =>
        new RuntimeRoleBootstrapError({
          reason: failure.reason,
        }),
    ),
  );
  const password = yield* Schema.decodeEffect(Schema.URLFromString)(connections.runtime.connectionString).pipe(
    Effect.flatMap((url) =>
      Effect.try({
        catch: (cause) => cause,
        try: () => url.searchParams.getAll('password').at(-1) ?? decodeURIComponent(url.password),
      }),
    ),
    Effect.mapError(
      (cause) =>
        new RuntimeRoleBootstrapError({
          reason: `Unable to read the runtime PostgreSQL role credentials: ${String(cause)}`,
        }),
    ),
  );
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
  const client = yield* connectAdmin(Redacted.make(connections.admin.connectionString));
  yield* bootstrapRuntimeRole(client, connections.admin.database, redactedPassword);
  yield* Effect.sync(() => console.log('Verified least-privilege PostgreSQL role ontos_runtime'));
}).pipe(
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.tapError((failure) => Effect.logError(failure.reason)),
);

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
