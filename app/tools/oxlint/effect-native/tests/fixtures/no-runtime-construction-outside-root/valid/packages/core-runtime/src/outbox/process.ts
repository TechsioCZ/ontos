// The A1 reference shape (`packages/core-runtime/src/outbox/process.ts:83`): one ManagedRuntime at
// the process entry point, everything below it staying an Effect.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const workerLayer: Layer.Layer<never>;
declare const program: Effect.Effect<void>;

export const startOutboxWorkerProcess = (): void => {
  const runtime = ManagedRuntime.make(workerLayer);
  void runtime.runPromise(program).then(() => {
    process.exitCode = 0;
  });
};
