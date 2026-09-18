import { Array as EffectArray, Console, Effect, Exit, Order, Redacted, Schema } from 'effect';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { getTableName } from 'drizzle-orm';

import { loadCommercePortalAuthDatabaseConfig } from './portal-auth-database-config.mts';
import { COMMERCE_PORTAL_AUTH_TABLES } from '../src/portal-auth/persistence/portal-auth-tables.ts';

class PortalAuthRuntimeBootstrapError extends Schema.TaggedError<PortalAuthRuntimeBootstrapError>()(
  'PortalAuthRuntimeBootstrapError',
  { reason: Schema.String },
) {}

const failure = (reason: string, cause?: unknown) =>
  Object.defineProperty(new PortalAuthRuntimeBootstrapError({ reason }), 'cause', { value: cause });

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const query = <Row extends QueryResultRow>(client: Client, sql: string, values: readonly string[] = []) =>
  Effect.callback<QueryResult<Row>, PortalAuthRuntimeBootstrapError>((resume) => {
    const completeQuery = (cause: Error, result: QueryResult<Row>) => {
      resume(cause === null ? Effect.succeed(result) : Effect.fail(failure('Provider privilege query failed', cause)));
    };
    client.query<Row>(sql, [...values], completeQuery);
  });

const main = Effect.scoped(
  Effect.gen(function* bootstrapPortalAuthRuntimeRole() {
    const configuration = yield* loadCommercePortalAuthDatabaseConfig();
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ connectionString: Redacted.value(configuration.admin.connectionString) })),
      (connection) =>
        Effect.callback<boolean>((resume) => {
          const closed = () => resume(Effect.succeed(true));
          connection.end(closed);
        }).pipe(Effect.asVoid),
    );
    yield* Effect.callback<boolean, PortalAuthRuntimeBootstrapError>((resume) => {
      const connected = (cause: Error | undefined) => {
        resume(
          cause === null || cause === undefined
            ? Effect.succeed(true)
            : Effect.fail(failure('Provider administrator connection failed', cause)),
        );
      };
      client.connect(connected);
    });
    const identity = yield* query<{ database: string; role: string }>(
      client,
      'select current_database() as database, current_user as role',
    );
    if (
      identity.rows[0]?.database !== configuration.admin.database ||
      identity.rows[0]?.role !== configuration.admin.user
    ) {
      yield* failure('Provider administrator connection does not match the configured identity');
    }
    const runtime = yield* query<{ safe: boolean }>(
      client,
      `select not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole
         and rolcanlogin as safe from pg_catalog.pg_roles where rolname = $1`,
      [configuration.runtime.user],
    );
    if (!runtime.rows[0]?.safe) {
      yield* failure('The configured provider runtime role must already exist as a restricted login role');
    }
    const tables = EffectArray.sort(COMMERCE_PORTAL_AUTH_TABLES.map(getTableName), Order.String);
    const inventory = yield* query<{ name: string }>(
      client,
      `select tablename as name from pg_catalog.pg_tables where schemaname = 'commerce_auth' order by tablename`,
    );
    if (inventory.rows.length !== tables.length || !inventory.rows.every((row, index) => row.name === tables[index])) {
      yield* failure('Provider schema must match its migrated table inventory before granting privileges');
    }
    const role = quoteIdentifier(configuration.runtime.user);
    yield* query(client, 'begin');
    yield* query(client, `grant connect on database ${quoteIdentifier(configuration.runtime.database)} to ${role}`);
    yield* query(client, `grant usage on schema commerce_auth to ${role}`);
    for (const table of tables) {
      yield* query(
        client,
        `grant select, insert, update, delete on table commerce_auth.${quoteIdentifier(table)} to ${role}`,
      );
    }
    yield* query(client, 'commit');
    yield* Console.log('Granted provider runtime privileges on the exact migrated Commerce authentication tables');
  }).pipe(Effect.tapError((failureValue) => Console.error(failureValue.reason))),
);

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
