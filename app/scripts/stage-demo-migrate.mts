#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Effect, Layer, Path, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { ChildProcess } from 'effect/unstable/process';

import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  runApplicationCompositionMigration,
} from './application-composition-authority-publication.mts';
import { verifyInitialCompositionCutover } from './initial-composition-cutover.mts';
import { ZeropsPublicApiLive } from './zerops-public-api.mts';

export class StageDemoMigrationError extends Schema.TaggedError<StageDemoMigrationError>()('StageDemoMigrationError', {
  exitCode: Schema.optionalKey(Schema.Number),
  message: Schema.String,
}) {}

const initialCutover = Effect.gen(function* verifyStageInitialCutover() {
  const [inventoryFile, receiptFile] = yield* Effect.all([
    Config.String('ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE'),
    Config.String('ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE'),
  ]);
  yield* verifyInitialCompositionCutover({ environment: 'stage', inventoryFile, receiptFile });
});

/** Keep the complete workspace migration chain inside the committed native seal, not a SQL transaction. */
export const migrateStageDemoOwnerSchemas = Effect.fn('StageDemo.migrateOwnerSchemas')(
  function* migrateStageDemoOwnerSchemas() {
    const path = yield* Path.Path;
    const migration = Effect.scoped(
      Effect.gen(function* runRunnerLocalOwnerMigrations() {
        const child = yield* ChildProcess.make('pnpm', ['db:migrate'], {
          cwd: path.resolve(import.meta.dirname, '..'),
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        });
        const exitCode = yield* child.exitCode;
        if (exitCode !== 0) {
          return yield* new StageDemoMigrationError({ exitCode, message: 'The stage owner migration chain failed' });
        }
        return yield* Effect.void;
      }),
    ).pipe(
      Effect.catchTag('PlatformError', () =>
        Effect.fail(new StageDemoMigrationError({ message: 'The runner-local stage migration process failed' })),
      ),
    );
    yield* runApplicationCompositionMigration(migration, initialCutover);
  },
);

if (import.meta.main) {
  const services = Layer.mergeAll(ApplicationCompositionAuthorityAdminDatabaseLive, ZeropsPublicApiLive).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  NodeRuntime.runMain(migrateStageDemoOwnerSchemas().pipe(Effect.provide(services)));
}
