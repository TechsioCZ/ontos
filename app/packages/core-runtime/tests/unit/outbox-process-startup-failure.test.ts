import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

const failedStartup = Effect.gen(function* failedStartupEffect() {
  const child = yield* ChildProcess.make(
    process.execPath,
    ['--experimental-strip-types', 'tests/fixtures/outbox-worker-startup-failure.fixture.ts'],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      extendEnv: true,
      forceKillAfter: '1 second',
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code, errors] = yield* Effect.all([child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)], {
    concurrency: 'unbounded',
  });

  expect(Number(code)).toBe(1);
  expect(errors).toMatch(/Outbox Worker process failed/u);
  expect(errors).toMatch(/WorkerDatabaseUnreachable: DATABASE_URL is not a PostgreSQL URL/u);
});

it.live(
  'a Worker whose runtime cannot start exits 1 and reports the cause on stderr',
  () =>
    Layer.build(NodeServices.layer).pipe(
      Effect.flatMap((nodeServices) => failedStartup.pipe(Effect.provide(nodeServices))),
      Effect.scoped,
    ),
  5000,
);
