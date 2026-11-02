import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import type { ApplicationMigrationStream } from '../../../application-migration-inventory.mts';
import { ApplicationMigrationObservationSchema } from '../../../application-migration-plan.mts';
import { observeApplicationMigrationState } from '../../../application-migration-runtime.mts';
import { collectToolingProcess } from '../../../tests/tooling-process-fixture.mts';

export const recoveryFixtureRelative = 'scripts/integration/fixtures/scoped-migration-recovery';
export const recoveryMigrationName = '20261102000000_scoped_recovery_native_fixture';
export const recoveryJournalName = '__drizzle_migrations_scoped_recovery_fixture';
export const recoveryOwner = 'scoped-migration-recovery-fixture';
export const recoverySchema = 'scoped_migration_recovery_fixture';

// Closed test process output contains observed physical identity, never a connection URL or password.
export const RecoveryObservationSchema = Schema.Struct({
  nativeTargets: Schema.Array(
    Schema.Struct({
      database: Schema.NonEmptyString,
      databaseKind: Schema.Literals(['primary', 'portal-auth']),
      databaseOid: Schema.NonEmptyString,
      host: Schema.NonEmptyString,
      port: Schema.Int,
      systemIdentifier: Schema.NonEmptyString,
      user: Schema.NonEmptyString,
    }),
  ),
  observations: Schema.Array(ApplicationMigrationObservationSchema),
});

export const loadRecoveryFixtureStream = Effect.fn('ScopedMigrationRecovery.fixtureStream')(function* fixtureStream() {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* fs.readFileString(
    path.join(import.meta.dirname, 'drizzle', recoveryMigrationName, 'migration.sql'),
  );
  const stream: ApplicationMigrationStream = {
    configFile: 'drizzle.config.ts',
    database: 'primary',
    directory: recoveryFixtureRelative,
    journalName: recoveryJournalName,
    migrationDirectory: `${recoveryFixtureRelative}/drizzle`,
    migrations: [{ hash: createHash('sha256').update(sql).digest('hex'), name: recoveryMigrationName }],
    optional: false,
    ownerId: recoveryOwner,
    preparationScripts: [],
    prerequisites: [],
    runtimeIdentityIds: [],
    schemas: [recoverySchema],
    verifierPaths: [],
  };
  return stream;
});

class RecoveryWrapperFailure extends Schema.TaggedError<RecoveryWrapperFailure>()('RecoveryWrapperFailure', {
  status: Schema.Number,
}) {}

const program = Effect.gen(function* observeOrCommitThenLoseAcknowledgement() {
  const operation = yield* Schema.decodeUnknownEffect(Schema.Literals(['observe', 'lose-ack']))(
    yield* Config.String('SCOPED_MIGRATION_RECOVERY_OPERATION'),
  );
  if (operation === 'observe') {
    const stream = yield* loadRecoveryFixtureStream();
    const state = yield* observeApplicationMigrationState([stream]);
    const output = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryObservationSchema))(state);
    return yield* Console.log(output);
  }
  const executable = yield* Config.String('SCOPED_MIGRATION_RECOVERY_CLI');
  const result = yield* collectToolingProcess(
    ChildProcess.make(executable, ['migrate', '--config', 'drizzle.config.ts'], {
      cwd: import.meta.dirname,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  );
  if (result.status !== 0) {
    return yield* new RecoveryWrapperFailure({ status: result.status });
  }
  // Parent proves committed SQL/journal directly, then kills this owned process before acknowledgement.
  return yield* Effect.never;
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  );
  process.exitCode = Exit.match(exit, { onFailure: () => 1, onSuccess: () => 0 });
}
