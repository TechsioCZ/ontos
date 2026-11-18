import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer, Stdio } from 'effect';
import { HttpClient } from 'effect/http';
import { ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { OpsCommandError } from '../ops/ops-command-error.mts';
import { OpsShell } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { main } from '../publish-active-application-composition.mts';

// Selected plans need native Core evidence; their lifecycle modes run against PostgreSQL in
// scripts/integration/application-migration-publication-cli-lifecycle.test.mts.
it.effect(
  'the actual migrate CLI refuses an unreviewed selected intent before deployment or the publication lifecycle',
  () =>
    Effect.gen(function* unreviewedIntentStopsMigration() {
      const fileSystem = yield* FileSystem.FileSystem;
      const appDirectory = yield* fileSystem.realPath(fileURLToPath(new URL('../../', import.meta.url)));
      const intentFile = 'scripts/tests/fixtures/migration-selected-intent.json';
      const commands: OpsCommand[] = [];
      let httpRequests = 0;
      let spawnedProcesses = 0;
      // git reports the intent outside source control, exactly as `ls-files --error-unmatch` fails.
      const shell = Layer.succeed(OpsShell, {
        run: (command) =>
          Effect.suspend(() => {
            commands.push(command);
            return Effect.fail(new OpsCommandError({ command: 'git ls-files', message: 'pathspec did not match' }));
          }),
      });
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.sync(() => {
            httpRequests += 1;
          }).pipe(Effect.andThen(Effect.die('An unreviewed migration must not reach the provider API'))),
        ),
      );
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawnedProcesses += 1;
          }).pipe(Effect.andThen(Effect.die('An unreviewed migration must not deploy the migrator'))),
        ),
      );
      const cliArguments = Stdio.layerTest({
        args: Effect.succeed([
          'migrate',
          '--environment',
          'lifecycle-cli-test',
          '--intent-file',
          intentFile,
          '--project-id',
          'unused-project',
          '--service-id',
          'unused-service',
          '--version-name',
          'unused-version',
          '--zerops-yaml-path',
          `${appDirectory}/zerops.yaml`,
        ]),
      });
      const refusal = yield* main.pipe(
        Effect.provide(
          Layer.mergeAll(
            shell,
            http,
            spawner,
            cliArguments,
            Reactivity.layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          ),
        ),
        Effect.provide(NodeServices.layer),
        Effect.andThen(Effect.die('An unreviewed selected intent must be refused')),
        Effect.catchTag('ApplicationReleaseIntentError', (error) => Effect.succeed(error.message)),
      );
      expect(refusal).toBe('the complete release intent must be source-controlled');
      expect(commands).toEqual([
        {
          args: ['ls-files', '--error-unmatch', '--', intentFile],
          command: 'git',
          cwd: appDirectory,
          env: {},
          extendEnv: false,
        },
      ]);
      expect(httpRequests).toBe(0);
      expect(spawnedProcesses).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
);
