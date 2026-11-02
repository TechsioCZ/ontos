import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Config, Effect, Exit, Fiber, Layer, Schedule, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { loadAdministrativeDatabaseConnection } from '../../packages/core-runtime/src/db/config.ts';
import { makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { applicationMigrationOwnerInventory } from '../application-migration-inventory.mts';
import { selectApplicationMigrationPlan } from '../application-migration-plan.mts';
import {
  ApplicationMigrationRuntimeError,
  assertSameApplicationMigrationTargets,
  reconcileApplicationMigrationOwner,
} from '../application-migration-runtime.mts';
import { quoteIdentifier } from '../postgres/database-login-roles.mts';
import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

import {
  RecoveryObservationSchema,
  loadRecoveryFixtureStream,
  recoveryFixtureRelative,
  recoveryJournalName as journalName,
  recoveryOwner as fixtureOwner,
  recoverySchema as fixtureSchema,
} from './fixtures/scoped-migration-recovery/lost-ack-wrapper.mts';

const services = Layer.mergeAll(NodeServices.layer, Reactivity.layer);

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDirectory = path.join(workspaceRoot, recoveryFixtureRelative);
const nativeCli = path.join(workspaceRoot, 'packages/core-runtime/node_modules/.bin/drizzle-kit');

class RecoveryFixtureFailure extends Schema.TaggedError<RecoveryFixtureFailure>()('RecoveryFixtureFailure', {
  stage: Schema.Literals(['owned_schema', 'isolated_observer']),
}) {}

const verifySchema = Effect.fn('ScopedMigrationRecovery.verifyActualSchema')(function* verifyActualSchema(
  client: PgClient.PgClient,
) {
  const columns = yield* client.unsafe<{ column_name: string }>(
    'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
    [fixtureSchema, 'proof'],
  );
  yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({ column_name: Schema.Literal('id') }),
      Schema.Struct({ column_name: Schema.Literal('effects') }),
      Schema.Struct({ column_name: Schema.Literal('native_applied') }),
    ]),
  )(columns).pipe(Effect.mapError(() => new RecoveryFixtureFailure({ stage: 'owned_schema' })));
  const rows = yield* client.unsafe<{ effects: number; id: number; native_applied: number }>(
    'select id, effects, native_applied from scoped_migration_recovery_fixture.proof order by id',
  );
  yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({ effects: Schema.Literal(1), id: Schema.Literal(1), native_applied: Schema.Literal(1) }),
    ]),
  )(rows).pipe(Effect.mapError(() => new RecoveryFixtureFailure({ stage: 'owned_schema' })));
});

const observeFixture = Effect.fn('ScopedMigrationRecovery.observeInIsolatedProcess')(function* observeInIsolatedProcess(
  env: Readonly<Record<string, string>>,
) {
  const result = yield* collectToolingProcess(
    ChildProcess.make(process.execPath, [path.join(fixtureDirectory, 'lost-ack-wrapper.mts')], {
      cwd: fixtureDirectory,
      env: { ...env, SCOPED_MIGRATION_RECOVERY_OPERATION: 'observe' },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  ).pipe(Effect.scoped, Effect.timeout('30 seconds'));
  if (result.status !== 0) {
    return yield* new RecoveryFixtureFailure({ stage: 'isolated_observer' });
  }
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RecoveryObservationSchema))(result.stdout);
});

const makeFixture = Effect.fn('ScopedMigrationRecovery.ownedDatabase')(function* ownedDatabase() {
  const connection = yield* loadAdministrativeDatabaseConnection();
  const administrator = yield* makeTestPgClient(connection.connectionString);
  const database = `ontos_scoped_recovery_${randomUUID().replaceAll('-', '')}`;
  const quotedDatabase = quoteIdentifier(database);
  yield* Effect.acquireRelease(administrator.unsafe(`create database ${quotedDatabase}`), () =>
    administrator.unsafe(`drop database ${quotedDatabase} with (force)`).pipe(Effect.orDie),
  );
  const url = new URL(connection.connectionString);
  url.pathname = `/${database}`;
  const connectionString = url.href;
  const client = yield* makeTestPgClient(connectionString);
  const stream = yield* loadRecoveryFixtureStream();
  const env = {
    APP_ENV_PATH: '/dev/null',
    DATABASE_ADMIN_URL: connectionString,
    PATH: yield* Config.String('PATH'),
    SCOPED_MIGRATION_RECOVERY_CLI: nativeCli,
  };
  const before = yield* observeFixture(env);
  expect(before.nativeTargets.map(({ database: actual }) => actual)).toEqual([database]);
  const plan = yield* selectApplicationMigrationPlan(
    { mode: 'selected', owners: [{ migrate: true, ownerId: fixtureOwner, verify: true }] },
    applicationMigrationOwnerInventory([stream]),
    before.observations,
  );
  const [owner] = plan.owners;
  if (owner === undefined) {
    return yield* Effect.die('Owned recovery fixture plan missing');
  }
  return { before, client, database, env, owner, quotedDatabase, stream };
});

type Fixture = Effect.Success<ReturnType<typeof makeFixture>>;
const runNative = (fixture: Fixture) =>
  collectToolingProcess(
    ChildProcess.make(nativeCli, ['migrate', '--config', 'drizzle.config.ts'], {
      cwd: fixtureDirectory,
      env: fixture.env,
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  ).pipe(Effect.scoped, Effect.timeout('45 seconds'));

const observeAgain = Effect.fn('ScopedMigrationRecovery.reconstructObservation')(function* reconstructObservation(
  fixture: Fixture,
) {
  const state = yield* observeFixture(fixture.env);
  yield* assertSameApplicationMigrationTargets(fixture.before.nativeTargets, state.nativeTargets);
  const [observation] = state.observations;
  if (observation === undefined) {
    return yield* Effect.die('Owned recovery observation missing');
  }
  return observation;
});

const assertSingleJournal = Effect.fn('ScopedMigrationRecovery.singleJournal')(function* singleJournal(
  fixture: Fixture,
) {
  const rows = yield* fixture.client.unsafe<{ hash: string; name: string | null }>(
    `select hash,to_jsonb(journal)->>'name' as name from drizzle.${quoteIdentifier(journalName)} as journal`,
  );
  expect(rows).toHaveLength(1);
  expect(rows.map(({ hash }) => hash)).toEqual(fixture.stream.migrations.map(({ hash }) => hash));
});

const awaitCommittedFixture = Effect.fn('ScopedMigrationRecovery.awaitCommittedFixture')(function* awaitCommitted(
  fixture: Fixture,
) {
  const [table] = yield* fixture.client.unsafe<{ present: boolean }>(
    'select pg_catalog.to_regclass($1) is not null as present',
    [`${fixtureSchema}.proof`],
  );
  if (!table?.present) {
    return false;
  }
  yield* verifySchema(fixture.client);
  yield* assertSingleJournal(fixture);
  return true;
});

const crashAfterCommit = Effect.fn('ScopedMigrationRecovery.crashOwnedWrapperAfterCommit')(function* crashOwnedWrapper(
  fixture: Fixture,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [path.join(fixtureDirectory, 'lost-ack-wrapper.mts')], {
      cwd: fixtureDirectory,
      env: { ...fixture.env, SCOPED_MIGRATION_RECOVERY_OPERATION: 'lose-ack' },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  );
  const stdout = yield* child.stdout.pipe(Stream.runDrain, Effect.forkChild);
  const stderr = yield* child.stderr.pipe(Stream.runDrain, Effect.forkChild);
  yield* awaitCommittedFixture(fixture).pipe(
    Effect.repeat({ schedule: Schedule.spaced('50 millis'), until: (committed) => committed }),
    Effect.timeout('20 seconds'),
  );
  // Reconstruct committed evidence in another real process before killing the still-unacknowledged wrapper.
  yield* observeAgain(fixture);
  yield* child.kill({ forceKillAfter: '1 second', killSignal: 'SIGKILL' });
  const [exit] = yield* Effect.all([child.exitCode.pipe(Effect.exit), Fiber.join(stdout), Fiber.join(stderr)], {
    concurrency: 'unbounded',
  });
  expect(Exit.match(exit, { onFailure: () => true, onSuccess: (code) => Number(code) !== 0 })).toBe(true);
});

it.live(
  'recovers committed native SQL after wrapper crash and retries the same folder without duplicate effects',
  () =>
    Effect.scoped(
      Effect.gen(function* lostAcknowledgement() {
        const fixture = yield* makeFixture();
        yield* crashAfterCommit(fixture);
        const after = yield* observeAgain(fixture);
        expect(yield* reconcileApplicationMigrationOwner(fixture.owner, after, verifySchema(fixture.client))).toBe(
          'committed',
        );
        yield* assertSingleJournal(fixture);
        const retry = yield* runNative(fixture);
        expect(retry.status).toBe(0);
        yield* verifySchema(fixture.client);
        yield* assertSingleJournal(fixture);
        expect((yield* observeAgain(fixture)).entries).toEqual(after.entries);
      }),
    ).pipe(Effect.provide(services)),
  60_000,
);
it.live(
  'observes a real native transaction rollback then commits one retry after the owned DB fault setting is cleared',
  () =>
    Effect.scoped(
      Effect.gen(function* rolledBackMigration() {
        const fixture = yield* makeFixture();
        yield* fixture.client.unsafe(
          `alter database ${fixture.quotedDatabase} set ontos.scoped_recovery_failure = 'on'`,
        );
        const failed = yield* runNative(fixture);
        expect(failed.status).not.toBe(0);
        const rolledBack = yield* observeAgain(fixture);
        expect(rolledBack.schemasPresent).toEqual([]);
        expect(rolledBack.entries).toEqual([]);
        expect(yield* reconcileApplicationMigrationOwner(fixture.owner, rolledBack, verifySchema(fixture.client))).toBe(
          'uncommitted',
        );
        yield* fixture.client.unsafe(
          `alter database ${fixture.quotedDatabase} set ontos.scoped_recovery_failure = 'off'`,
        );
        expect((yield* runNative(fixture)).status).toBe(0);
        const committed = yield* observeAgain(fixture);
        expect(yield* reconcileApplicationMigrationOwner(fixture.owner, committed, verifySchema(fixture.client))).toBe(
          'committed',
        );
        yield* assertSingleJournal(fixture);
      }),
    ).pipe(Effect.provide(services)),
  60_000,
);
it.live(
  'refuses recovery completion for actual journal hash corruption and for schema drift despite a matching journal',
  () =>
    Effect.scoped(
      Effect.gen(function* conflictingDurableEvidence() {
        const fixture = yield* makeFixture();
        expect((yield* runNative(fixture)).status).toBe(0);
        yield* fixture.client.unsafe(`update drizzle.${quoteIdentifier(journalName)} set hash = $1`, ['f'.repeat(64)]);
        const corrupted = yield* observeAgain(fixture);
        const journalFailure = yield* reconcileApplicationMigrationOwner(
          fixture.owner,
          corrupted,
          verifySchema(fixture.client),
        ).pipe(Effect.flip);
        expect(Schema.is(ApplicationMigrationRuntimeError)(journalFailure)).toBe(true);
        yield* fixture.client.unsafe(
          `update drizzle.${quoteIdentifier(journalName)} set hash = $1`,
          fixture.stream.migrations.map(({ hash }) => hash),
        );
        yield* fixture.client.unsafe('alter table scoped_migration_recovery_fixture.proof drop column native_applied');
        const changedSchema = yield* observeAgain(fixture);
        const schemaFailure = yield* reconcileApplicationMigrationOwner(
          fixture.owner,
          changedSchema,
          verifySchema(fixture.client),
        ).pipe(Effect.flip);
        expect(Schema.is(RecoveryFixtureFailure)(schemaFailure)).toBe(true);
        expect(Schema.is(Schema.Struct({ stage: Schema.Literal('owned_schema') }))(schemaFailure)).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
  60_000,
);
