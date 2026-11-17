import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

const failedStartup = Effect.gen(function* failedStartupEffect() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: new URL('../..', import.meta.url).pathname,
    prefix: '.outbox-startup-',
  });
  const bundle = `${directory}/host.mjs`;
  // Test the real host's failure/cleanup protocol, not Node's TypeScript loader
  // traversing the entire Core graph in every subprocess.
  const compilation = yield* ChildProcess.make(
    'pnpm',
    [
      'exec',
      'esbuild',
      'packages/core-runtime/tests/fixtures/outbox-worker-startup-failure.fixture.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${bundle}`,
    ],
    {
      cwd: new URL('../../../..', import.meta.url).pathname,
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'ignore',
    },
  );
  const [compiled, diagnostics] = yield* Effect.all(
    [compilation.exitCode, compilation.stderr.pipe(Stream.decodeText(), Stream.mkString)],
    { concurrency: 'unbounded' },
  );
  expect(Number(compiled), diagnostics).toBe(0);
  const child = yield* ChildProcess.make(process.execPath, [bundle], {
    cwd: new URL('../..', import.meta.url).pathname,
    extendEnv: true,
    forceKillAfter: '1 second',
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [code, errors] = yield* Effect.all([child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)], {
    concurrency: 'unbounded',
  });

  expect(Number(code)).toBe(1);
  expect(errors).toBe('Outbox Worker host failed: WorkerDatabaseUnreachable, Defect\n');
});

it.live(
  'a Worker whose runtime cannot start exits 1 and names the failure on stderr without its message',
  () =>
    Layer.build(NodeServices.layer).pipe(
      Effect.flatMap((nodeServices) => failedStartup.pipe(Effect.provide(nodeServices))),
      Effect.scoped,
    ),
  5000,
);
