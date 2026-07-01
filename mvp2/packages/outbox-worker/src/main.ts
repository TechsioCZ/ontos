// @effect-diagnostics nodeBuiltinImport:off processEnv:off
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

  void Effect.runPromise(
    Effect.logInfo(`[outbox-worker] received ${signal}; shutting down`).pipe(
      Effect.zipRight(Fiber.interrupt(loopFiber)),
      Effect.zipRight(Effect.promise(() => sqlClient.end({ timeout: 5 }))),
    ),
  )
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      void Effect.runPromise(Effect.logError('[outbox-worker] shutdown failed', error));
      process.exitCode = 1;
    });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

void Effect.runPromise(
  Effect.logInfo('[outbox-worker] started', {
    registrations: installedOutboxWorkerRegistrations.length,
    runtimeId: config.runtimeId,
  }),
);
