import { createHash } from 'node:crypto';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Effect, FileSystem, Path, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { assert, expect } from 'effect-rstest';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';

const databaseUsernameArgument = '--username';

interface MigrationConnection {
  readonly connectionString: string;
  readonly database: string;
  readonly user: string;
}
interface QuantityMigrationConnections {
  readonly admin: MigrationConnection;
  readonly runtime: MigrationConnection;
}
const MigrationReceiptSchema = Schema.Struct({
  count: Schema.Int,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
});
const quantityJournalReceipt = Effect.fn('QuantityProfileAdmissionTests.journalReceipt')(function* receipt(
  connection: MigrationConnection,
  owner: 'core' | 'commerce_customer_context',
) {
  const table =
    owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context';
  const child = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      databaseUsernameArgument,
      connection.user,
      '--dbname',
      connection.database,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      `set time zone 'UTC'; select json_build_object('count', count(*)::integer, 'digest', md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]'))) from ${table} journal`,
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(connection.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationReceiptSchema))(output.join('').trim());
});
const copyQuantityMigrationJournal = Effect.fn('QuantityProfileAdmissionTests.copyMigrationJournal')(function* copy(
  source: MigrationConnection,
  target: MigrationConnection,
  owner: 'core' | 'commerce_customer_context',
) {
  const before = yield* quantityJournalReceipt(source, owner);
  expect((yield* quantityJournalReceipt(target, owner)).count).toBe(0);
  const table =
    owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context';
  const dump = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'pg_dump',
      '--host',
      'localhost',
      databaseUsernameArgument,
      source.user,
      '--dbname',
      source.database,
      '--data-only',
      '--column-inserts',
      '--table',
      table,
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(source.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const restore = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      databaseUsernameArgument,
      target.user,
      '--dbname',
      target.database,
      '--set',
      'ON_ERROR_STOP=1',
      '--quiet',
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(target.connectionString).password),
      },
      stderr: 'pipe',
      stdin: dump.stdout,
      stdout: 'pipe',
    },
  );
  const [dumpExit, restoreExit] = yield* Effect.all(
    [
      dump.exitCode,
      restore.exitCode,
      Stream.runDrain(dump.stderr),
      Stream.runDrain(restore.stderr),
      Stream.runDrain(restore.stdout),
    ],
    { concurrency: 5 },
  );
  expect(Number(dumpExit)).toBe(0);
  expect(Number(restoreExit)).toBe(0);
  expect(yield* quantityJournalReceipt(target, owner)).toEqual(before);
  expect(yield* quantityJournalReceipt(source, owner)).toEqual(before);
});
const runQuantityMigrationCommand = Effect.fn('QuantityProfileAdmissionTests.migrationCommand')(function* run(
  connections: QuantityMigrationConnections,
  owner: 'core' | 'commerce_customer_context',
  command: 'migrate' | 'verify',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-quantity-profile-current-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    "export default { dialect:'postgresql', out:process.env.ONTOS_QUANTITY_MIGRATIONS, schema:process.env.ONTOS_QUANTITY_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_commerce_customer_context'} };",
  );
  const args =
    owner === 'core'
      ? ['--filter', '@app/core-runtime', command === 'migrate' ? 'db:migrate' : 'db:verify']
      : [
          '--filter',
          '@app/commerce-customer-context',
          ...(command === 'migrate' ? ['exec', 'drizzle-kit', 'migrate', '--config', configuration] : ['db:verify']),
        ];
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', ...args], {
    cwd: new URL('../../../../', import.meta.url).pathname,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: connections.admin.connectionString,
      DATABASE_URL: connections.runtime.connectionString,
      ONTOS_QUANTITY_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
      ONTOS_QUANTITY_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [status] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stderr), Stream.runDrain(child.stdout)], {
    concurrency: 3,
  });
  if (Number(status) !== 0) {
    yield* Effect.logError({ failureClass: 'OWNED_MIGRATION_COMMAND_FAILED', operation: command, owner });
  }
  expect(Number(status)).toBe(0);
});
const applyQuantityProfileCurrentMigrations = Effect.fn('QuantityProfileAdmissionTests.currentMigrations')(
  function* migrate(connections: QuantityMigrationConnections) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    expect(connections.admin.database).toBe(connections.runtime.database);
    expect(connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
    expect(connections.admin.database).not.toBe(source.admin.database);
    expect(connections.admin.database).not.toBe(source.runtime.database);
    const sourceCore = yield* quantityJournalReceipt(source.admin, 'core');
    const sourceOwner = yield* quantityJournalReceipt(source.admin, 'commerce_customer_context');
    // Finalizers are installed before any copy/migration, including failures during setup.
    yield* Effect.addFinalizer(() =>
      Effect.scoped(
        Effect.gen(function* sourceJournalsUnchanged() {
          expect(yield* quantityJournalReceipt(source.admin, 'core')).toEqual(sourceCore);
          expect(yield* quantityJournalReceipt(source.admin, 'commerce_customer_context')).toEqual(sourceOwner);
        }),
      ).pipe(Effect.orDie),
    );
    yield* copyQuantityMigrationJournal(source.admin, connections.admin, 'core');
    yield* copyQuantityMigrationJournal(source.admin, connections.admin, 'commerce_customer_context');
    yield* runQuantityMigrationCommand(connections, 'core', 'migrate');
    yield* runQuantityMigrationCommand(connections, 'core', 'verify');
    const currentCore = yield* quantityJournalReceipt(connections.admin, 'core');
    yield* runQuantityMigrationCommand(connections, 'core', 'migrate');
    expect(yield* quantityJournalReceipt(connections.admin, 'core')).toEqual(currentCore);
    yield* runQuantityMigrationCommand(connections, 'commerce_customer_context', 'migrate');
    yield* runQuantityMigrationCommand(connections, 'commerce_customer_context', 'verify');
    const currentOwner = yield* quantityJournalReceipt(connections.admin, 'commerce_customer_context');
    yield* runQuantityMigrationCommand(connections, 'commerce_customer_context', 'migrate');
    expect(yield* quantityJournalReceipt(connections.admin, 'commerce_customer_context')).toEqual(currentOwner);
    expect(yield* quantityJournalReceipt(connections.admin, 'core')).toEqual(currentCore);

    const fs = yield* FileSystem.FileSystem;
    const sqlSource = yield* fs.readFileString(
      new URL('../../drizzle/20261019224858_quantity_profile_admission/migration.sql', import.meta.url).pathname,
    );
    const client = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
      Effect.provide(Reactivity.layer),
    );
    const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const [receipt] = yield* admin.execute<{
      readonly body: string;
      readonly canonicalPath: boolean;
      readonly currentReceipt: boolean;
      readonly ownerIsAdmin: boolean;
      readonly publicExecute: boolean;
      readonly rowSecurity: boolean;
      readonly runtimeExecute: boolean;
      readonly securityDefiner: boolean;
    }>(
      sql`select routine.prosrc as body,
    'search_path=pg_catalog, commerce_customer_context, pg_temp' = any(routine.proconfig) as "canonicalPath",
    'row_security=on' = any(routine.proconfig) as "rowSecurity",
    routine.prosecdef as "securityDefiner", pg_get_userbyid(routine.proowner) = current_user as "ownerIsAdmin",
    has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE') as "runtimeExecute",
    exists(select 1 from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
      where acl.grantee=0 and acl.privilege_type='EXECUTE') as "publicExecute",
    exists(select 1 from drizzle.__drizzle_migrations_commerce_customer_context
      where created_at=${Date.UTC(2026, 9, 19, 22, 48, 58)} and name='20261019224858_quantity_profile_admission'
      and hash=${createHash('sha256').update(sqlSource).digest('hex')}) as "currentReceipt"
    from pg_catalog.pg_proc routine
    where routine.oid='commerce_customer_context.inspect_commerce_quantity_assignment_profile(uuid,uuid,text,text)'::regprocedure`,
      'objects',
    );
    const verified = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        body: Schema.String,
        canonicalPath: Schema.Literal(true),
        currentReceipt: Schema.Literal(true),
        ownerIsAdmin: Schema.Literal(true),
        publicExecute: Schema.Literal(false),
        rowSecurity: Schema.Literal(true),
        runtimeExecute: Schema.Literal(true),
        securityDefiner: Schema.Literal(true),
      }),
    )(receipt);
    const [, expectedBody] = sqlSource.split('AS $routine$');
    const [body] = expectedBody?.split('$routine$;') ?? [];
    assert.isOk(body !== undefined);
    expect(verified.body.replaceAll('\r\n', '\n').trim()).toBe(body.replaceAll('\r\n', '\n').trim());
    const coreSql = yield* fs.readFileString(
      new URL(
        '../../../../packages/core-runtime/drizzle/20261019193926_retained-owner-change-history/migration.sql',
        import.meta.url,
      ).pathname,
    );
    const [coreReceipt] = yield* admin.execute<{
      readonly body: string;
      readonly canonicalPath: boolean;
      readonly currentReceipt: boolean;
      readonly ownerIsAdmin: boolean;
      readonly publicExecute: boolean;
      readonly runtimeExecute: boolean;
      readonly securityDefiner: boolean;
    }>(
      sql`select routine.prosrc as body,
      'search_path=pg_catalog, core' = any(routine.proconfig) as "canonicalPath",
      routine.prosecdef as "securityDefiner", pg_get_userbyid(routine.proowner)=current_user as "ownerIsAdmin",
      has_function_privilege('ontos_runtime',routine.oid,'EXECUTE') as "runtimeExecute",
      exists(select 1 from aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
        where acl.grantee=0 and acl.privilege_type='EXECUTE') as "publicExecute",
      exists(select 1 from drizzle.__drizzle_migrations_core
        where created_at=${Date.UTC(2026, 9, 19, 19, 39, 26)} and name='20261019193926_retained-owner-change-history'
        and hash=${createHash('sha256').update(coreSql).digest('hex')}) as "currentReceipt"
      from pg_catalog.pg_proc routine
      where routine.oid='core.read_committed_owner_change_history_v1(uuid,uuid,text,jsonb,jsonb,integer)'::regprocedure`,
      'objects',
    );
    const coreVerified = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        body: Schema.String,
        canonicalPath: Schema.Literal(true),
        currentReceipt: Schema.Literal(true),
        ownerIsAdmin: Schema.Literal(true),
        publicExecute: Schema.Literal(false),
        runtimeExecute: Schema.Literal(false),
        securityDefiner: Schema.Literal(true),
      }),
    )(coreReceipt);
    const [, coreDefinition] = coreSql.split('AS $function$');
    const [coreBody] = coreDefinition?.split('$function$;') ?? [];
    assert.isOk(coreBody !== undefined);
    expect(coreVerified.body.trim()).toBe(coreBody.trim());
    const [guard] = yield* admin.execute<{ readonly body: string; readonly enabled: boolean }>(
      sql`
      select routine.prosrc as body, exists(
        select 1 from pg_catalog.pg_trigger trigger
        where trigger.tgrelid='commerce_customer_context.commerce_quantity_rule_assignments'::regclass
          and trigger.tgfoid=routine.oid and not trigger.tgisinternal and trigger.tgenabled<>'D'
      ) as enabled
      from pg_catalog.pg_proc routine
      where routine.oid='commerce_customer_context.guard_commerce_quantity_rule_assignment()'::regprocedure`,
      'objects',
    );
    const guardVerified = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ body: Schema.String, enabled: Schema.Literal(true) }),
    )(guard);
    const [, guardDefinition] = sqlSource.split('AS $$');
    const [guardBody] = guardDefinition?.split('$$;') ?? [];
    assert.isOk(guardBody !== undefined);
    expect(guardVerified.body.trim()).toBe(guardBody.trim());

    expect(yield* quantityJournalReceipt(source.admin, 'core')).toEqual(sourceCore);
    expect(yield* quantityJournalReceipt(source.admin, 'commerce_customer_context')).toEqual(sourceOwner);
    return { commerceCustomerContext: currentOwner, core: currentCore };
  },
);

export const makeQuantityProfileOwnedDatabase = Effect.fn('QuantityProfileAdmissionTests.ownedDatabase')(
  function* makeOwnedDatabase(snapshot: ActiveApplicationCompositionSnapshot) {
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose: 'stabilization-1266-quantity-profile-admission',
    });
    yield* isolated.assertClonedSchema();
    const receipts = yield* applyQuantityProfileCurrentMigrations(isolated.connections);
    return { isolated, receipts };
  },
);
