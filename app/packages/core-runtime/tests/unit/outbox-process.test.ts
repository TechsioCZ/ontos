import { NodeServices } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

const gracefulShutdown = (signal: 'SIGINT' | 'SIGTERM') =>
  Effect.gen(function* gracefulShutdownEffect() {
    const child = yield* ChildProcess.make(
      process.execPath,
      ['--experimental-strip-types', 'tests/fixtures/outbox-worker-process.fixture.ts'],
      {
        cwd: new URL('../..', import.meta.url).pathname,
        env: {
          OUTBOX_WORKER_MAX_DELIVERIES: '1',
          OUTBOX_WORKER_POLL_INTERVAL_MS: '10',
        },
        extendEnv: true,
        forceKillAfter: '1 second',
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const readyToStop = yield* Deferred.make<null>();
    const outputFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.tap((line) =>
        line === 'cycle:1' ? Deferred.succeed(readyToStop, null).pipe(Effect.asVoid) : Effect.void,
      ),
      Stream.runCollect,
      Effect.forkChild,
    );
    const errorsFiber = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.forkChild,
    );

    yield* Deferred.await(readyToStop);
    yield* child.kill({ killSignal: signal });
    const [code, outputLines, errors] = yield* Effect.all(
      [child.exitCode, Fiber.join(outputFiber), Fiber.join(errorsFiber)],
      { concurrency: 'unbounded' },
    );
    const output = outputLines.join('\n');

    expect(Number(code), `${errors}\n${output}`).toBe(0);
    expect(output).toMatch(/cycle:1/u);
    expect(output).toMatch(/disposed/u);
  });

const assertGracefulShutdown = (signal: 'SIGINT' | 'SIGTERM') =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((nodeServices) => gracefulShutdown(signal).pipe(Effect.provide(nodeServices))),
    Effect.scoped,
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it.live(
    `${signal} interrupts polling and disposes the managed worker runtime`,
    () => assertGracefulShutdown(signal),
    5000,
  );
}
