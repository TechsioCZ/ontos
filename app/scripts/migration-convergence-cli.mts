import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { CORE_MIGRATION_MANIFEST } from '../packages/core-runtime/scripts/migration-equivalence.mts';
import { PARTY_MIGRATION_MANIFESTS } from '../verticals/party-registry/scripts/migration-equivalence.mts';
import { prepareContactsMigration } from '../verticals/party-registry/scripts/prepare-contacts-migration.mts';
import {
  convergeMigrationHistories,
  loadConvergentMigrationSource,
  migrationDatabaseLayer,
} from './migration-convergence.mts';
import { MigrationEquivalenceError } from './migration-equivalence.mts';

const OwnerSchema = Schema.Literals(['core', 'party']);

/** The deployed migrator uses the installed owner's CLI, not the build workspace's package discovery. */
export const ownerSnapshotCheckCommand = (owner: typeof OwnerSchema.Type, folder: string) => {
  const directory = fileURLToPath(
    new URL(owner === 'core' ? '../packages/core-runtime/' : '../verticals/party-registry/', import.meta.url),
  );
  return ChildProcess.make(
    path.join(directory, 'node_modules/.bin/drizzle-kit'),
    ['check', '--dialect', 'postgresql', '--out', folder],
    { cwd: directory, stderr: 'inherit', stdout: 'inherit' },
  );
};

export const runOwnerMigrationConvergence = Effect.fn('MigrationConvergence.owner')(function* run(
  owner: typeof OwnerSchema.Type,
) {
  const manifests = owner === 'core' ? [CORE_MIGRATION_MANIFEST] : PARTY_MIGRATION_MANIFESTS;
  const sources = yield* Effect.forEach(manifests, (manifest) => loadConvergentMigrationSource(manifest), {
    concurrency: 1,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  for (const { manifest } of sources) {
    const code = yield* spawner.exitCode(ownerSnapshotCheckCommand(owner, manifest.folder)).pipe(
      Effect.timeout('60 seconds'),
      Effect.mapError(
        () =>
          new MigrationEquivalenceError({
            history: manifest.history,
            reason: 'Native snapshot check failed or timed out',
          }),
      ),
    );
    if (code !== 0) {
      return yield* new MigrationEquivalenceError({
        history: manifest.history,
        reason: 'Native snapshot history is not converged',
      });
    }
  }
  const prepare =
    owner === 'core'
      ? Effect.void
      : PgClient.PgClient.pipe(
          Effect.flatMap(prepareContactsMigration),
          Effect.asVoid,
          Effect.mapError(
            () => new MigrationEquivalenceError({ history: 'contacts', reason: 'Contacts journal preparation failed' }),
          ),
        );
  yield* convergeMigrationHistories(sources, prepare);
  return yield* Effect.logInfo('Owner migration histories converged through native Drizzle');
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = Command.make(
    'migration-convergence',
    { owner: Argument.Literals('owner', ['core', 'party']) },
    ({ owner }) => runOwnerMigrationConvergence(owner),
  ).pipe(Command.provide(({ owner }) => migrationDatabaseLayer(owner).pipe(Layer.provide(Reactivity.layer))));
  NodeRuntime.runMain(
    Effect.scoped(Command.run({ version: '1.0.0' })(cli)).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
}
