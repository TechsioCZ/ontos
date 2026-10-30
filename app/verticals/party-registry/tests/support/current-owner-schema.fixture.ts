import { fileURLToPath } from 'node:url';

import {
  DatabaseConfig,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeRuntime, NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Config, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

import { PartyDatabase, PartyDatabaseLive } from '../../src/db/client.ts';

class CurrentOwnerSchemaFixtureError extends Schema.TaggedError<CurrentOwnerSchemaFixtureError>()(
  'CurrentOwnerSchemaFixtureError',
  { reason: Schema.String },
) {}

const failed = (reason: string) => new CurrentOwnerSchemaFixtureError({ reason });
const ownerDirectory = fileURLToPath(new URL('../../', import.meta.url));
const runOwnerCommand = Effect.fn('CurrentPartySchema.runOwnerCommand')(function* runOwnerCommand(
  command: 'db:migrate' | 'db:verify',
  environment: Readonly<Record<string, string>>,
) {
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', command], {
    cwd: ownerDirectory,
    env: environment,
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (exitCode !== 0) {
    return yield* failed(`The actual Party ${command} command failed`);
  }
});

const isOwnedFixtureConfiguration = (connections: DatabaseConnectionPair, expected: string, source: string) =>
  /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(expected) &&
  expected !== source &&
  connections.admin.database === expected &&
  connections.runtime.database === expected &&
  [connections.admin, connections.runtime].every(({ host }) => ['localhost', '127.0.0.1'].includes(host)) &&
  connections.runtime.user === 'ontos_runtime';

const OwnerSchemaPhaseSchema = Schema.Literals(['rebuild', 'verify']);

const prepare = Effect.fn('CurrentPartySchema.prepare')(function* prepareCurrentOwnerSchema(
  phase: typeof OwnerSchemaPhaseSchema.Type,
) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const expectedDatabase = yield* Config.String('ONTOS_FIXTURE_OWNED_DATABASE');
  const sourceDatabase = yield* Config.String('ONTOS_FIXTURE_SOURCE_DATABASE');
  if (!isOwnedFixtureConfiguration(connections, expectedDatabase, sourceDatabase)) {
    return yield* failed('The Party schema fixture requires the exact owned disposable database');
  }
  const { executor } = yield* PartyDatabase;
  const [identity] = yield* executor.execute<{ database: string; owner: string; currentUser: string }>(
    sql`
    select current_database() as database,current_user as "currentUser",pg_get_userbyid(datdba) as owner
    from pg_database where datname=current_database()`,
    'objects',
  );
  if (
    identity?.database !== expectedDatabase ||
    identity.currentUser !== connections.admin.user ||
    identity.owner !== connections.admin.user
  ) {
    return yield* failed('The Party schema fixture database ownership does not match its trusted configuration');
  }
  const environment = {
    APP_ENV_PATH: '/dev/null',
    DATABASE_ADMIN_URL: connections.admin.connectionString,
    DATABASE_URL: connections.runtime.connectionString,
    PATH: yield* Config.String('PATH'),
  };
  if (phase === 'verify') {
    const request = yield* loadDatabaseConfig({ envPath: '/dev/null', identity: PARTY_REGISTRY_REQUEST_IDENTITY });
    if (
      request.database !== expectedDatabase ||
      request.host !== connections.admin.host ||
      request.port !== connections.admin.port
    ) {
      return yield* failed('Party verification requires the dedicated identity in this exact owned clone');
    }
    yield* runOwnerCommand('db:verify', { ...environment, PARTY_REGISTRY_DATABASE_URL: request.connectionString });
    yield* Effect.logInfo('Verified canonical Party owner schema in its owned disposable fixture database');
    return;
  }
  const [runtime] = yield* executor.execute<{ unsafe: boolean }>(
    sql`select rolsuper or rolbypassrls as unsafe from pg_roles where rolname=${connections.runtime.user}`,
    'objects',
  );
  if (runtime?.unsafe !== false) {
    return yield* failed('The Party fixture runtime role must retain forced RLS');
  }
  const [foreign] = yield* executor.execute<{ count: number }>(
    sql`
    select count(*)::integer as count from pg_constraint c join pg_class own on own.oid=c.conrelid
    join pg_namespace own_ns on own_ns.oid=own.relnamespace join pg_class referenced on referenced.oid=c.confrelid
    join pg_namespace referenced_ns on referenced_ns.oid=referenced.relnamespace
    where c.contype='f' and referenced_ns.nspname in ('party','contacts','crm') and own_ns.nspname not in ('party','contacts','crm')`,
    'objects',
  );
  if (foreign?.count !== 0) {
    return yield* failed('Another owner references the Party fixture schemata');
  }
  const tables = yield* executor.execute<{ name: string; schema: string }>(
    sql`
    select tablename as name,schemaname as schema from pg_tables where schemaname in ('party','contacts','crm')`,
    'objects',
  );
  for (const table of tables) {
    const [row] = yield* executor.execute<{ populated: boolean }>(
      sql`select exists(select 1 from ${sql.identifier(table.schema)}.${sql.identifier(table.name)} limit 1) as populated`,
      'objects',
    );
    if (row?.populated !== false) {
      return yield* failed('The Party schema fixture only replaces empty copied owner schemata');
    }
  }
  // Only this scope's empty clone is reachable. Rebuild both actual CLI-owned domains and journals.
  for (const schema of ['party', 'contacts', 'crm']) {
    yield* executor.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`, 'objects');
  }
  for (const journal of ['__drizzle_migrations_party', '__drizzle_migrations_contacts', '__drizzle_migrations_crm']) {
    yield* executor.execute(sql`drop table if exists drizzle.${sql.identifier(journal)}`, 'objects');
  }
  yield* runOwnerCommand('db:migrate', environment);
  // Historical migrations may grant the shared role access. This owned clone must
  // use the canonical dedicated Party identity, including the global replay table.
  const runtimeRole = sql.identifier(connections.runtime.user);
  yield* executor.execute(sql`revoke all on all tables in schema party,contacts from ${runtimeRole}`, 'objects');
  yield* executor.execute(sql`revoke all on schema party,contacts from ${runtimeRole}`, 'objects');
  yield* Effect.logInfo('Rebuilt owned Party schema; canonical identity setup and verification remain pending');
});

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* runCurrentOwnerSchemaFixture() {
      // Missing or unknown phases fail before any pool acquisition or owner mutation.
      const phase = yield* Schema.decodeUnknownEffect(OwnerSchemaPhaseSchema)(process.argv[2]);
      if (process.argv.length !== 3) {
        return yield* failed('Exactly one Party owner schema phase is required');
      }
      const services = yield* Layer.build(
        Layer.mergeAll(
          PartyDatabaseLive.pipe(
            Layer.provide(
              Layer.effect(
                DatabaseConfig,
                loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(Effect.map((pair) => pair.admin)),
              ),
            ),
          ),
          NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      );
      return yield* prepare(phase).pipe(Effect.provideContext(services));
    }),
  ),
);
