// One-shot scripts are out of scope unless `includeScripts` is set.
import { Effect, ManagedRuntime, Layer } from 'effect';

declare const seedLayer: Layer.Layer<never>;

const runtime = ManagedRuntime.make(seedLayer);
void runtime.runPromise(Effect.void);
