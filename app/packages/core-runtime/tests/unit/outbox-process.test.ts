import assert from 'node:assert/strict';
import test from 'node:test';

import { makeEffectTestCallback } from '@app/core-runtime/testing/effect-runtime';
import { NodeServices } from '@effect/platform-node';
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

const gracefulShutdown = (signal: 'SIGINT' | 'SIGTERM') =>
  Effect.gen(function* gracefulShutdownEffect() {
    const child = yield* ChildProcess.make(
      process.execPath,
      [
        '--experimental-strip-types',
        'tests/fixtures/outbox-worker-process.fixture.ts',
      ],
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
      }
    );
    const readyToStop = yield* Deferred.make<null>();
    const outputFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.tap((line) =>
        line === 'cycle:1'
          ? Deferred.succeed(readyToStop, null).pipe(Effect.asVoid)
          : Effect.void
      ),
      Stream.runCollect,
      Effect.forkChild
    );
    const errorsFiber = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.forkChild
    );

    yield* Deferred.await(readyToStop);
    yield* child.kill({ killSignal: signal });
    const [code, outputLines, errors] = yield* Effect.all(
      [child.exitCode, Fiber.join(outputFiber), Fiber.join(errorsFiber)],
      { concurrency: 'unbounded' }
    );
    const output = outputLines.join('\n');

    assert.equal(Number(code), 0, `${errors}\n${output}`);
    assert.match(output, /cycle:1/u);
    assert.match(output, /disposed/u);
  });

const assertGracefulShutdown = (signal: 'SIGINT' | 'SIGTERM') =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((nodeServices) =>
      gracefulShutdown(signal).pipe(Effect.provide(nodeServices))
    ),
    Effect.scoped
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  void test(
    `${signal} interrupts polling and disposes the managed worker runtime`,
    { timeout: 5000 },
    makeEffectTestCallback(assertGracefulShutdown(signal))
  );
}
