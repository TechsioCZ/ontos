// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { Effect } from 'effect';

const assertGracefulShutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'tests/fixtures/outbox-worker-process.fixture.ts'],
    {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        OUTBOX_WORKER_MAX_DELIVERIES: '1',
        OUTBOX_WORKER_POLL_INTERVAL_MS: '10',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let errors = '';
  let terminationRequested = false;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (!terminationRequested && output.match(/cycle:1\n/gu)?.length === 2) {
      terminationRequested = true;
      child.kill(signal);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });

  const result = await Effect.runPromise(
    Effect.callback<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resume) => {
      const onError = (error: Error) => resume(Effect.die(error));
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
        resume(Effect.succeed({ code, signal: exitSignal }));
      child.once('error', onError);
      child.once('exit', onExit);
      return Effect.sync(() => {
        child.off('error', onError);
        child.off('exit', onExit);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: '3 seconds',
        orElse: () =>
          Effect.sync(() => child.kill('SIGKILL')).pipe(
            Effect.flatMap(() => Effect.die(new Error(`worker process did not stop\n${errors}`))),
          ),
      }),
    ),
  );

  assert.deepEqual(result, { code: 0, signal: null }, `${errors}\n${output}`);
  assert.match(output, /cycle:1/u);
  assert.match(output, /disposed/u);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  void test(`${signal} interrupts polling and disposes the managed worker runtime`, async () =>
    await assertGracefulShutdown(signal));
}
