// Other Effect namespaces keep their own `provide` semantics; only `Effect.provide*` is the seam leak.
import { Layer, ManagedRuntime, Effect } from "effect";

declare const AppLayer: Layer.Layer<never, never, never>;
declare const BaseLayer: Layer.Layer<never, never, never>;
declare const program: Effect.Effect<void, never, never>;

export const runtime = ManagedRuntime.make(AppLayer.pipe(Layer.provide(BaseLayer)));

// Running a program through a captured runtime is the A1 target, not a local provide.
export const run = () => runtime.runPromise(program);
