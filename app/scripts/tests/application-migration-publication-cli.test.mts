import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { OpsShell } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { main } from '../publish-active-application-composition.mts';

it.effect(
  'executes the actual publication CLI none path without database, Legacy owner, provider file or API initialization',
  () =>
    Effect.gen(function* publicationCliNone() {
      const fileSystem = yield* FileSystem.FileSystem;
      const appDirectory = yield* fileSystem.realPath(fileURLToPath(new URL('../../', import.meta.url)));
      const intentFile = 'scripts/tests/fixtures/migration-none-intent.json';
      const absentProvider = fileURLToPath(new URL('fixtures/nonexistent-migration-provider.yaml', import.meta.url));
      expect(yield* fileSystem.exists(absentProvider)).toBe(false);
      const commands: OpsCommand[] = [];
      let httpRequests = 0;
      const expectedGit: OpsCommand = {
        args: ['ls-files', '--error-unmatch', '--', intentFile],
        command: 'git',
        cwd: appDirectory,
        env: {},
        extendEnv: false,
      };
      // Only the checked-in-intent command is scripted; the real CLI, JSON decoder and filesystem run.
      const shell = Layer.succeed(OpsShell, {
        run: (command) =>
          Effect.sync(() => {
            commands.push(command);
            expect(command).toEqual(expectedGit);
            return `${intentFile}\n`;
          }),
      });
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.sync(() => {
            httpRequests += 1;
          }).pipe(Effect.andThen(Effect.die('No publication HTTP request is allowed for none mode'))),
        ),
      );
      const globalServices = Layer.mergeAll(NodeServices.layer, Reactivity.layer, shell, http);
      const previousArguments = process.argv;
      process.argv = [
        process.execPath,
        'publish-active-application-composition.mts',
        'migrate',
        '--environment',
        'none-cli-test',
        '--intent-file',
        intentFile,
        '--project-id',
        'unused-project',
        '--service-id',
        'unused-service',
        '--version-name',
        'unused-version',
        '--zerops-yaml-path',
        absentProvider,
      ];
      try {
        yield* Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(globalServices))).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          Effect.scoped,
        );
      } finally {
        process.argv = previousArguments;
      }
      expect(commands).toEqual([expectedGit]);
      expect(httpRequests).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
);
