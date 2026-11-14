import { fileURLToPath } from 'node:url';

import { OntosActionContractSchema, OntosOutboxSubscriptionContractSchema } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Path, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

const ownerDirectory = fileURLToPath(new URL('../../', import.meta.url));
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const descriptionSchema = Schema.Struct({
  marker: Schema.Struct({ appId: Schema.String }),
  originatorActions: Schema.Array(Schema.String),
  runtime: Schema.Struct({ actions: Schema.Array(OntosActionContractSchema) }),
  subscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
});

it.layer(nativeServices, { excludeTestServices: true })((suite) =>
  suite.effect(
    'describes the native privacy worker without importing browser components or opening a database',
    () =>
      Effect.scoped(
        Effect.gen(function* describePrivacyWorker() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parent = path.join(ownerDirectory, '.cache');
          yield* fs.makeDirectory(parent, { recursive: true });
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: parent,
            prefix: 'privacy-worker-description-',
          });
          const artifact = path.join(directory, 'worker.mjs');
          const build = yield* ChildProcess.make(
            path.join(ownerDirectory, '../../node_modules/esbuild/bin/esbuild'),
            [
              path.join(ownerDirectory, 'tests/support/privacy-completion-worker.ts'),
              '--bundle',
              '--platform=node',
              '--format=esm',
              '--packages=external',
              '--define:ULTRAMODERN_BUILD_MARKER="aaebe4ee5a28e557"',
              '--define:ULTRAMODERN_SOURCE_REVISION="workspace"',
              `--outfile=${artifact}`,
            ],
            {
              cwd: ownerDirectory,
              env: { APP_ENV_PATH: '/dev/null' },
              extendEnv: false,
              stderr: 'pipe',
              stdin: 'ignore',
              stdout: 'pipe',
            },
          );
          const [buildExit, buildError] = yield* Effect.all(
            [build.exitCode, build.stderr.pipe(Stream.decodeText, Stream.mkString), Stream.runDrain(build.stdout)],
            { concurrency: 3 },
          );
          expect(buildExit, buildError).toBe(0);
          const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
            cwd: ownerDirectory,
            env: { APP_ENV_PATH: '/dev/null' },
            extendEnv: false,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          });
          const [exit, output, error] = yield* Effect.all(
            [
              describe.exitCode,
              describe.stdout.pipe(Stream.decodeText, Stream.mkString),
              describe.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
            { concurrency: 3 },
          );
          expect(exit, error).toBe(0);
          const description = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(descriptionSchema))(output);
          expect(description.marker.appId).toBe('party-registry');
          expect(description.runtime.actions.length).toBeGreaterThan(0);
          expect(description.originatorActions).toEqual(['privacy.core.dispatch-privacy-measure']);
          expect(description.subscriptions.length).toBeGreaterThan(0);
        }),
      ),
    { timeout: 120_000 },
  ),
);
