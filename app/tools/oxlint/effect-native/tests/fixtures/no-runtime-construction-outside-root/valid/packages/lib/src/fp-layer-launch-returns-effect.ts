// FALSE POSITIVE regression: `Layer.launch` is not runtime construction.
// effect@4.0.0-beta.107 `Layer.d.ts:3413`:
//   `export declare const launch: <RIn, E, ROut>(self: Layer<ROut, E, RIn>) => Effect<never, E, RIn>`
// It builds the layer and returns an `Effect` that still carries `RIn` — no Runtime, no
// ManagedRuntime, no independent pools/tracer/logger, and it cannot drop the caller's span,
// annotations or interruption. Exporting a worker main as an Effect for the root to run is exactly
// what this rule's own message ("Keep this module an `Effect<A, E, R>` and let the root run it")
// asks for, yet it is reported.
import { Effect, Layer } from 'effect';

declare const workerLayer: Layer.Layer<never>;

export const workerMain: Effect.Effect<never> = Layer.launch(workerLayer);
