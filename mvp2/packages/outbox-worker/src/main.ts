// @effect-diagnostics globalConsole:off nodeBuiltinImport:off processEnv:off
import { sqlClient } from '@mvp2/core-runtime/db/client';
import { Effect, Fiber } from 'effect';
import { readOutboxWorkerRuntimeConfig } from './config.ts';
import { installedOutboxWorkerRegistrations } from './installed-workers.registry.ts';
import { makeOutboxWorkerLoop } from './runtime.ts';

const config = readOutboxWorkerRuntimeConfig();
const loopFiber = Effect.runFork(
  makeOutboxWorkerLoop({
    config,
    registrations: installedOutboxWorkerRegistrations,
  }),
);

let shuttingDown = false;

const shutdown = (signal: string): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.info(`[outbox-worker] received ${signal}; shutting down`);

  void Effect.runPromise(Fiber.interrupt(loopFiber))
    .then(() => sqlClient.end({ timeout: 5 }))
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error('[outbox-worker] shutdown failed', error);
      process.exitCode = 1;
    });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

console.info('[outbox-worker] started', {
  registrations: installedOutboxWorkerRegistrations.length,
  runtimeId: config.runtimeId,
});
