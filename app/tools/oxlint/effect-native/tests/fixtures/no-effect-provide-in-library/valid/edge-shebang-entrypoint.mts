#!/usr/bin/env node
// Shebang parse check on the blessed outer process seam.
import { Effect, Layer } from "effect";

declare const program: Effect.Effect<void, never, never>;
declare const RuntimeLive: Layer.Layer<never, never, never>;

await Effect.runPromise(Effect.provide(program, RuntimeLive));
