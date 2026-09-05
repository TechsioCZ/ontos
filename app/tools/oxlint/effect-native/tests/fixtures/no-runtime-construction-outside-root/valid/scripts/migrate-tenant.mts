// A `scripts/*.mts` executable entry point owns exactly one ManagedRuntime for its own process and
// disposes it at the edge — the D-tier "process-exit adapter" the audit blesses.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const migrationLayer: Layer.Layer<never>;
declare const migrate: Effect.Effect<void>;

const runtime = ManagedRuntime.make(Layer.orDie(migrationLayer));

try {
  await runtime.runPromise(migrate);
} finally {
  await runtime.dispose();
}
