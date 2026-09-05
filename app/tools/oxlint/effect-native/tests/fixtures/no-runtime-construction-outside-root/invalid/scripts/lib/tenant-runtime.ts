// expect-count: 1
// A helper module under `scripts/**` is not an executable entry point: it must stay an Effect and let
// the script entry point own the process runtime.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const seedLayer: Layer.Layer<never>;

const runtime = ManagedRuntime.make(seedLayer);

export const seed = async (): Promise<void> => runtime.runPromise(Effect.void);
