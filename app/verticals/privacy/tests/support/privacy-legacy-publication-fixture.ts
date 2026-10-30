// TEST infrastructure. This executable is never imported by the operator harness.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices, NodeStream } from '@effect/platform-node';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Effect, Layer, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import { ownerExecutionOutcomes, privacyMeasureDispatches, privacyRelations } from '../../src/database/schema.ts';

const PrivacyLegacyFixtureCommandSchema = Schema.Literals([
  'describe',
  'prepare-empty',
  'dispatch-old',
  'observe',
  'hold-owner-write',
  'release',
]);
class PrivacyLegacyFixtureFailure extends Schema.TaggedError<PrivacyLegacyFixtureFailure>()(
  'PrivacyLegacyFixtureFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new PrivacyLegacyFixtureFailure({ reason });
const description = {
  commands: PrivacyLegacyFixtureCommandSchema.literals,
  historicalProducer: 'pinned legacy startup via fixed public completion session; local dispatch-old is refused',
  owner: 'privacy.core',
  protocolVersion: 1,
  publicAckProducer: 'fixed creator-bound public completion session',
};
type FixtureMessage =
  | typeof description
  | { readonly databaseOid: string; readonly type: 'prepared' }
  | {
      readonly dispatches: number;
      readonly historySha256: string;
      readonly measureIds: readonly string[];
      readonly outcomeIds: readonly string[];
      readonly outcomes: number;
      readonly type: 'observation';
    }
  | {
      readonly backendXid: string;
      readonly databaseOid: string;
      readonly pid: number;
      readonly type: 'writer-started';
      readonly virtualTransaction: string;
    }
  | { readonly pid: number; readonly type: 'writer-held' | 'released' }
  | { readonly type: 'failed' };
const write = Effect.fn('PrivacyLegacyFixture.write')((message: FixtureMessage) =>
  Effect.sync(() => process.stdout.write(`${JSON.stringify(message)}\n`)),
);

const migrationToolEnvironment = Effect.fn('PrivacyLegacyFixture.migrationToolEnvironment')(
  function* migrationToolEnvironment(directory: string, path: string) {
    const mise = yield* Config.all({
      MISE_BACKENDS_PNPM: Config.String('MISE_BACKENDS_PNPM').pipe(Config.withDefault('')),
      MISE_CACHE_DIR: Config.String('MISE_CACHE_DIR').pipe(Config.withDefault('')),
      MISE_DATA_DIR: Config.String('MISE_DATA_DIR').pipe(Config.withDefault('')),
      MISE_STATE_DIR: Config.String('MISE_STATE_DIR').pipe(Config.withDefault('')),
    });
    const usesTaskLocalMise = Object.values(mise).some((value) => value !== '');
    const taskRoot = new URL('../../../', pathToFileURL(`${directory}/`)).pathname;
    if (
      usesTaskLocalMise &&
      (mise.MISE_BACKENDS_PNPM !== 'npm:pnpm' ||
        mise.MISE_DATA_DIR !== `${taskRoot}.native-toolchain` ||
        mise.MISE_CACHE_DIR !== `${taskRoot}.native-cache` ||
        mise.MISE_STATE_DIR !== `${taskRoot}.native-state`)
    ) {
      return yield* failure('Invalid task-local Mise environment');
    }
    return usesTaskLocalMise ? { PATH: path, ...mise } : { PATH: path };
  },
);

const run = Effect.fn('PrivacyLegacyFixture.run')(function* run(
  command: typeof PrivacyLegacyFixtureCommandSchema.Type,
) {
  if (command === 'describe') {
    return yield* write(description);
  }
  // Refuse before any DB access. Never synthesize old history with new-format NULL columns.
  if (command === 'dispatch-old') {
    return yield* failure(description.historicalProducer);
  }
  if (command === 'release') {
    return yield* failure('release is accepted only on the holding process stdin');
  }
  const settings = yield* Config.all({
    admin: Config.Redacted('DATABASE_ADMIN_URL'),
    database: Config.String('ONTOS_1258_OWNED_DATABASE'),
    databaseOid: Config.String('ONTOS_1258_OWNED_DATABASE_OID'),
    directory: Config.String('ONTOS_1258_PRIVACY_DIRECTORY'),
    path: Config.String('PATH'),
    runtime: Config.Redacted('DATABASE_URL'),
    systemIdentifier: Config.String('ONTOS_1258_OWNED_SYSTEM_IDENTIFIER'),
  });
  const buildEnvironment = yield* migrationToolEnvironment(settings.directory, settings.path);
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(settings.admin),
    DATABASE_URL: Redacted.value(settings.runtime),
  });
  if (
    !/^ontos_test_party_gateway_[a-f\d]{32}$/u.test(settings.database) ||
    ![connections.admin, connections.runtime].every(
      (value) => value.database === settings.database && ['localhost', '127.0.0.1'].includes(value.host),
    ) ||
    !settings.directory.endsWith('/verticals/privacy')
  ) {
    return yield* failure('Owner fixture requires the creator-bound local test database');
  }
  const reactivity = yield* Reactivity.make;
  const configuration = yield* configureDatabasePool(settings.admin);
  const client = yield* PgClient.make({ ...configuration, maxConnections: 1 }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  );
  const executor = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client),
  );
  // Native catalog identity is infrastructure metadata, not a foreign business read.
  const identities = yield* client<{
    readonly administrative: boolean;
    readonly databaseOid: string;
    readonly owned: boolean;
    readonly runtimeSafe: boolean;
    readonly systemIdentifier: string;
  }>`select d.oid::text as "databaseOid",(pg_control_system()).system_identifier::text as "systemIdentifier",
    pg_get_userbyid(d.datdba)=current_user as owned,
    (a.rolsuper or a.rolbypassrls) as administrative,
    (not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole
      and r.rolname<>current_user) as "runtimeSafe"
    from pg_database d cross join pg_roles a cross join pg_roles r
    where d.datname=current_database() and a.rolname=current_user and r.rolname=${connections.runtime.user}`;
  const [identity] = identities;
  if (
    identities.length !== 1 ||
    identity === undefined ||
    !identity.owned ||
    !identity.administrative ||
    !identity.runtimeSafe ||
    identity.databaseOid !== settings.databaseOid ||
    identity.systemIdentifier !== settings.systemIdentifier
  ) {
    return yield* failure('Owner fixture native identity does not match its creator capability');
  }
  if (command === 'prepare-empty') {
    // This owner's supported migration command alone; no raw business seed or foreign migration import.
    const migration = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', 'db:migrate'], {
      cwd: settings.directory,
      env: {
        DATABASE_ADMIN_URL: Redacted.value(settings.admin),
        DATABASE_URL: Redacted.value(settings.runtime),
        ...buildEnvironment,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [code] = yield* Effect.all(
      [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
      { concurrency: 3 },
    );
    if (code !== 0) {
      return yield* failure('Privacy-owned empty database migration failed');
    }
    return yield* write({ databaseOid: identity.databaseOid, type: 'prepared' });
  }
  if (command === 'observe') {
    const dispatches = yield* executor
      .select()
      .from(privacyMeasureDispatches)
      .orderBy(privacyMeasureDispatches.measureId)
      .limit(10_001);
    const outcomes = yield* executor
      .select()
      .from(ownerExecutionOutcomes)
      .orderBy(ownerExecutionOutcomes.outcomeId)
      .limit(10_001);
    if (dispatches.length > 10_000 || outcomes.length > 10_000) {
      return yield* failure('Owner history exceeds the bounded observation protocol');
    }
    return yield* write({
      dispatches: dispatches.length,
      historySha256: createHash('sha256').update(JSON.stringify({ dispatches, outcomes })).digest('hex'),
      measureIds: dispatches.map((row) => row.measureId),
      outcomeIds: outcomes.map((row) => row.outcomeId),
      outcomes: outcomes.length,
      type: 'observation',
    });
  }
  return yield* executor.transaction(() =>
    Effect.gen(function* holdOwnerWrite() {
      // Allocate the xid before observing locks and decode the native xid8 value as text.
      yield* client`select pg_current_xact_id()::text`;
      const [backend] = yield* client<{
        readonly backendXid: string;
        readonly databaseOid: string;
        readonly pid: number;
        readonly virtualTransaction: string;
      }>`select pg_backend_pid() as pid, d.oid::text as "databaseOid",
        (pg_current_xact_id()::text::bigint % 4294967296)::text as "backendXid", l.virtualtransaction as "virtualTransaction"
        from pg_database d join pg_locks l on l.pid=pg_backend_pid() and l.locktype='transactionid' and l.granted and l.mode='ExclusiveLock'
          and l.transactionid::text=(pg_current_xact_id()::text::bigint % 4294967296)::text
        where d.datname=current_database()`;
      if (backend === undefined) {
        return yield* failure('Owner writer backend is unavailable');
      }
      yield* write({ ...backend, type: 'writer-started' });
      // A real old writer needs ROW EXCLUSIVE. No business rows are mutated by this contention probe.
      yield* executor.execute(
        sql`lock table ${privacyMeasureDispatches}, ${ownerExecutionOutcomes} in row exclusive mode`,
        'objects',
      );
      yield* write({ pid: backend.pid, type: 'writer-held' });
      const lines = yield* NodeStream.fromReadable({
        evaluate: () => process.stdin,
        onError: () => failure('Owner writer release transport is unavailable'),
      }).pipe(Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.runCollect);
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Literal('release')))(lines[0]);
      return yield* write({ pid: backend.pid, type: 'released' });
    }),
  );
});

// No migrations, connections, owner calls or subprocesses are initialized by module discovery/import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(
    Effect.scoped(
      Schema.decodeUnknownEffect(PrivacyLegacyFixtureCommandSchema)(process.argv[2]).pipe(
        Effect.flatMap(run),
        Effect.matchEffect({
          onFailure: () => write({ type: 'failed' }).pipe(Effect.andThen(Effect.fail(failure('Owner fixture failed')))),
          onSuccess: () => Effect.void,
        }),
        Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ),
  );
}
