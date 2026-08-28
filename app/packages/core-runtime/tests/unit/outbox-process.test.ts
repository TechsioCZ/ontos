// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off nodeBuiltinImport:off processEnv:off
/* eslint-disable promise/avoid-new -- Child-process events are bounded explicitly. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

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

  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      },
    ),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`worker process did not stop\n${errors}`));
      }, 3000);
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  assert.deepEqual(result, { code: 0, signal: null }, `${errors}\n${output}`);
  assert.match(output, /cycle:1/u);
  assert.match(output, /disposed/u);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  void test(`${signal} interrupts polling and disposes the managed worker runtime`, async () =>
    await assertGracefulShutdown(signal));
}
