/// <reference types="node" />

import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Exit, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
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
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The runtime URL is the single source of the provider runtime credential, exactly as
 * `DATABASE_URL` is for `ontos_runtime` and `SPICEDB_DATABASE_PASSWORD` is for `spicedb`.
 */
const runtimePassword = (connectionString: Redacted.Redacted) =>
  Effect.try({
    catch: (cause) => failure('The provider runtime URL must carry a password', cause),
    try: () => {
      const url = new URL(Redacted.value(connectionString));
      return url.searchParams.getAll('password').at(-1) ?? decodeURIComponent(url.password);
    },
  }).pipe(
    Effect.filterOrFail(
      (password) => password.length > 0,
      () => failure('The provider runtime URL must carry a password'),
    ),
  );

const query = <Row extends object>(client: PgClient.PgClient, sql: string, values: readonly string[] = []) =>
  client.unsafe<Row>(sql, values).pipe(Effect.mapError((cause) => failure('Provider privilege query failed', cause)));

const main = Effect.scoped(
  Effect.gen(function* bootstrapPortalAuthRuntimeRole() {
    const configuration = yield* loadCommercePortalAuthDatabaseConfig();
    const client = yield* PgClient.makeClient({ url: configuration.admin.connectionString }).pipe(
      Effect.mapError((cause) => failure('Provider administrator connection failed', cause)),
    );
    const [identity] = yield* query<{ database: string; role: string }>(
      client,
      'select current_database() as database, current_user as role',
    );
    if (identity?.database !== configuration.admin.database || identity.role !== configuration.admin.user) {
      yield* failure('Provider administrator connection does not match the configured identity');
    }
    const tables = EffectArray.sort(COMMERCE_PORTAL_AUTH_TABLES.map(getTableName), Order.String);
    const inventory = yield* query<{ name: string }>(
      client,
      `select tablename as name from pg_catalog.pg_tables where schemaname = 'commerce_auth' order by tablename`,
    );
    if (inventory.length !== tables.length || !inventory.every((row, index) => row.name === tables[index])) {
      yield* failure('Provider schema must match its migrated table inventory before granting privileges');
    }
    const role = quoteIdentifier(configuration.runtime.user);
    const password = quoteLiteral(yield* runtimePassword(configuration.runtime.connectionString));
    yield* client
      .withTransaction(
        Effect.gen(function* provisionRuntimeRole() {
          // A fresh deployment gets the role; a redeployment re-asserts its restrictions and the
          // credential its runtime URL names. An existing role is inspected before any mutation, so a
          // runtime URL that names a privileged role fails without rewriting that role.
          const restrictedLoginRole = `select not rolsuper and not rolbypassrls and not rolcreatedb
               and not rolcreaterole and rolcanlogin as safe from pg_catalog.pg_roles where rolname = $1`;
          const [existing] = yield* query<{ safe: boolean }>(client, restrictedLoginRole, [configuration.runtime.user]);
          if (existing !== undefined && !existing.safe) {
            yield* failure('The configured provider runtime role exists but is not a restricted login role');
          }
          yield* query(
            client,
            `${existing === undefined ? 'create' : 'alter'} role ${role} login password ${password}
               nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
          );
          const [provisioned] = yield* query<{ safe: boolean }>(client, restrictedLoginRole, [
            configuration.runtime.user,
          ]);
          if (provisioned === undefined || !provisioned.safe) {
            yield* failure('The provider runtime role must be a restricted login role');
          }
          yield* query(
            client,
            `grant connect on database ${quoteIdentifier(configuration.runtime.database)} to ${role}`,
          );
          yield* query(client, `grant usage on schema commerce_auth to ${role}`);
          for (const table of tables) {
            yield* query(
              client,
              `grant select, insert, update, delete on table commerce_auth.${quoteIdentifier(table)} to ${role}`,
            );
          }
        }),
      )
      .pipe(
        Effect.catchTag('SqlError', (cause) => Effect.fail(failure('Provider runtime role transaction failed', cause))),
      );
    yield* Console.log(
      'Provisioned the provider runtime role and granted it the exact migrated Commerce authentication tables',
    );
  }).pipe(Effect.tapError((failureValue) => Console.error(failureValue.reason))),
);

const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(Reactivity.layer)));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
