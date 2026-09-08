// The root barrel at the blessed outer process seam: still one program, one Layer, one run.
import * as EffectNs from "effect";

declare const program: EffectNs.Effect.Effect<void, never, never>;
declare const RuntimeLive: EffectNs.Layer.Layer<never, never, never>;

await EffectNs.Effect.runPromise(EffectNs.Effect.provide(program, RuntimeLive));

export const forked = EffectNs.Effect.runFork(program.pipe(EffectNs.Effect.provideService(RuntimeLive, RuntimeLive)));
