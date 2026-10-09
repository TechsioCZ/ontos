import { NodeServices } from '@effect/platform-node';
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

class WorkerProcessTestFailure extends Schema.TaggedError<WorkerProcessTestFailure>()('WorkerProcessTestFailure', {
  message: Schema.String,
  phase: Schema.Literals(['startup', 'shutdown']),
  reason: Schema.Literals(['early_exit', 'timeout']),
}) {}

const gracefulShutdown = (signal: 'SIGINT' | 'SIGTERM', fixture = 'tests/fixtures/outbox-worker-process.fixture.ts') =>
  Effect.gen(function* gracefulShutdownEffect() {
    const child = yield* ChildProcess.make(process.execPath, ['--experimental-strip-types', fixture], {
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
    });
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
    const errorsFiber = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkChild);

    const exitedBeforeReadiness = child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.all([Fiber.join(outputFiber), Fiber.join(errorsFiber)], { concurrency: 'unbounded' }).pipe(
          Effect.flatMap(([outputLines, errors]) =>
            Effect.fail(
              new WorkerProcessTestFailure({
                message: `Worker exited with code ${Number(code)} before its first cycle\n${errors}\n${outputLines.join('\n')}`,
                phase: 'startup',
                reason: 'early_exit',
              }),
            ),
          ),
        ),
      ),
    );
    yield* Deferred.await(readyToStop).pipe(
      Effect.raceFirst(exitedBeforeReadiness),
      Effect.timeoutOrElse({
        duration: '10 seconds',
        orElse: () =>
          Effect.fail(
            new WorkerProcessTestFailure({
              message: 'Worker did not reach its first polling cycle within 10 seconds',
              phase: 'startup',
              reason: 'timeout',
            }),
          ),
      }),
    );
    // Import and composition verification precede readiness; the signal tests bound shutdown itself.
    const [code, outputLines, errors] = yield* child.kill({ killSignal: signal }).pipe(
      Effect.andThen(
        Effect.all([child.exitCode, Fiber.join(outputFiber), Fiber.join(errorsFiber)], { concurrency: 'unbounded' }),
      ),
      Effect.timeoutOrElse({
        duration: '1 second',
        orElse: () =>
          Effect.fail(
            new WorkerProcessTestFailure({
              message: `Worker did not exit and dispose within 1 second after ${signal}`,
              phase: 'shutdown',
              reason: 'timeout',
            }),
          ),
      }),
    );
    const output = outputLines.join('\n');

    expect(Number(code), `${errors}\n${output}`).toBe(0);
    expect(output).toMatch(/cycle:1/u);
    expect(output).toMatch(/disposed/u);
  });

const assertGracefulShutdown = (
  signal: 'SIGINT' | 'SIGTERM',
  fixture = 'tests/fixtures/outbox-worker-process.fixture.ts',
) =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((nodeServices) => gracefulShutdown(signal, fixture).pipe(Effect.provide(nodeServices))),
    Effect.scoped,
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it.live(
    `${signal} interrupts polling and disposes the managed worker runtime`,
    () => assertGracefulShutdown(signal),
    12_000,
  );
}

it.live(
  'reports a worker that exits before readiness with its exit code and stderr',
  () =>
    Effect.gen(function* reportStartupExit() {
      const failure = yield* Effect.flip(
        assertGracefulShutdown('SIGTERM', 'tests/fixtures/outbox-worker-startup-failure.fixture.ts'),
      );
      expect(failure).toBeInstanceOf(WorkerProcessTestFailure);
      expect(failure).toMatchObject({ phase: 'startup', reason: 'early_exit' });
      expect(failure.message).toMatch(/Worker exited with code 1 before its first cycle/u);
      expect(failure.message).toMatch(/Outbox Worker host failed: WorkerDatabaseUnreachable, Defect/u);
    }),
  12_000,
);

const failFastProcess = Effect.gen(function* failFastProcessEffect() {
  const child = yield* ChildProcess.make(
    process.execPath,
    ['--experimental-strip-types', 'tests/fixtures/outbox-worker-host-fail-fast.fixture.ts'],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { OUTBOX_WORKER_POLL_INTERVAL_MS: '10' },
      extendEnv: true,
      forceKillAfter: '1 second',
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code, output, errors] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ],
    { concurrency: 'unbounded' },
  );

  expect(Number(code), `${errors}\n${output}`).toBe(1);
  expect(output).toMatch(/cycle:billing:billing-outbox-worker/u);
  expect(output).toMatch(/cycle:ledger:ledger-outbox-worker/u);
  expect(output).toMatch(/disposed:billing/u);
  expect(output).toMatch(/disposed:ledger/u);
  expect(errors).toMatch(/^Outbox Worker host failed: .*Defect/u);
  expect(errors).not.toMatch(/fixture loop defect/u);
});

it.live(
  'one failing hosted loop exits the host non-zero after disposing every hosted runtime',
  () =>
    Layer.build(NodeServices.layer).pipe(
      Effect.flatMap((nodeServices) => failFastProcess.pipe(Effect.provide(nodeServices))),
      Effect.scoped,
    ),
  10_000,
);
