import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpClient } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import {
  runApplicationCompositionMigration,
  withApplicationCompositionPublicationLock,
} from '../application-composition-authority-publication.mts';
import {
  prepareApplicationMigrationPlan,
  readApplicationMigrationRequirements,
} from '../application-migration-runtime.mts';
import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
import { OpsShell } from '../ops/ops-shell.mts';
import { main } from '../publish-active-application-composition.mts';

// This test executes argument parsing, reviewed input validation, provider materialization and
// the actual migrate command. Native effects stop at the lifecycle boundary, tested separately.
rs.mock('../application-composition-authority-publication.mts', () => ({
  get ApplicationCompositionAuthorityAdminDatabaseLive() {
    return Layer.empty;
  },
  runApplicationCompositionMigration: rs.fn(() => Effect.void),
  withApplicationCompositionPublicationLock: rs.fn(() => Effect.die('The CLI must not bypass migration lifecycle')),
}));
rs.mock('../application-composition-legacy-owners.mts', () => ({
  get ApplicationCompositionLegacyOwnersLive() {
    return Layer.empty;
  },
}));
rs.mock('../application-migration-runtime.mts', () => ({
  prepareApplicationMigrationPlan: rs.fn(),
  readApplicationMigrationRequirements: rs.fn(),
}));

it.effect('the actual migrate CLI sends SQL and no-SQL plans through the same lifecycle with their exact mode', () =>
  Effect.gen(function* cliUsesMigrationLifecycle() {
    const filesystem = yield* FileSystem.FileSystem;
    const appDirectory = yield* filesystem.realPath(fileURLToPath(new URL('../../', import.meta.url)));
    const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: 'migration-cli-lifecycle-' });
    const intentFile = 'scripts/tests/fixtures/migration-selected-intent.json';
    const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
      yield* filesystem.readFileString(`${appDirectory}/${intentFile}`),
    );
    if (intent.migrationRequirements === undefined) {
      return yield* Effect.die('The CLI fixture must select migration requirements');
    }
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const { composition } = snapshot;
    const baselineRevision = '1'.repeat(64);
    const candidateFile = `${directory}/candidate.json`;
    const expectedCompositionFile = `${directory}/expected.json`;
    const selectionFile = `${directory}/selection.json`;
    yield* filesystem.writeFileString(
      candidateFile,
      JSON.stringify({
        baseline: { retainedModuleAppIds: [], revision: baselineRevision, shellMode: 'fresh' },
        modules: [],
        shell: {
          deployment: composition.shell.deployment,
          federationManifest: composition.shell.federationManifest,
          runtimeContract: composition.shell.runtimeContract,
        },
      }),
    );
    yield* filesystem.writeFileString(expectedCompositionFile, JSON.stringify(composition));
    yield* filesystem.writeFileString(
      selectionFile,
      JSON.stringify({
        complete: [],
        fresh: [],
        migrationRequirements: intent.migrationRequirements,
        removed: [],
        retained: [],
        shell: {
          mode: 'fresh',
          unit: {
            id: 'shell-super-app',
            packageName: 'shell-super-app',
            path: 'apps/shell-super-app',
            workerName: 'shell',
          },
        },
      }),
    );
    const shell = Layer.succeed(OpsShell, {
      run: (command) =>
        Effect.sync(() => {
          expect(command.command).toBe('git');
          expect(command.args).toEqual(['ls-files', '--error-unmatch', '--', intentFile]);
          return `${intentFile}\n`;
        }),
    });
    const globals = Layer.mergeAll(
      NodeServices.layer,
      Reactivity.layer,
      shell,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die('The CLI wiring test must not call a real provider')),
      ),
    );
    for (const mode of ['migrate', 'verify-only'] as const) {
      rs.mocked(readApplicationMigrationRequirements).mockReturnValue(Effect.succeed(intent.migrationRequirements));
      rs.mocked(prepareApplicationMigrationPlan).mockReturnValue(
        Effect.succeed({
          nativeTargets: [],
          plan: {
            initializationOwners: [],
            mode: 'selected',
            owners: [
              {
                before: {
                  catalogFingerprint: 'a'.repeat(64),
                  entries: [],
                  journalExists: true,
                  journalName: '__drizzle_migrations_core',
                  ownerId: 'core-runtime',
                  schemaEvidence: 'observed-journal',
                  schemasPresent: ['core'],
                },
                migrate: true,
                ownerId: 'core-runtime',
                pendingMigrations: mode === 'migrate' ? [{ hash: 'b'.repeat(64), name: '20261101000000_fixture' }] : [],
                verification: 'pending',
                verify: true,
              },
            ],
            schemaVersion: 1,
          },
          streams: [],
        }),
      );
      rs.mocked(runApplicationCompositionMigration).mockClear();
      const previousArguments = process.argv;
      process.argv = [
        process.execPath,
        'publish-active-application-composition.mts',
        'migrate',
        '--environment',
        'lifecycle-cli-test',
        '--intent-file',
        intentFile,
        '--candidate-file',
        candidateFile,
        '--expected-composition-file',
        expectedCompositionFile,
        '--selection-file',
        selectionFile,
        '--project-id',
        'unused-project',
        '--service-id',
        'unused-service',
        '--version-name',
        'unused-version',
        '--zerops-yaml-path',
        `${appDirectory}/zerops.yaml`,
      ];
      try {
        yield* Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(globals))).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          Effect.scoped,
        );
      } finally {
        process.argv = previousArguments;
      }
      expect(runApplicationCompositionMigration).toHaveBeenCalledTimes(1);
      const [call] = rs.mocked(runApplicationCompositionMigration).mock.calls;
      expect(call?.[2]).toEqual({ baselineRevision, targetRevision: composition.revision });
      expect(call?.[3]).toBe(mode);
      expect(Effect.isEffect(call?.[0])).toBe(true);
      expect(Effect.isEffect(call?.[1])).toBe(true);
      expect(withApplicationCompositionPublicationLock).not.toHaveBeenCalled();
    }
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
