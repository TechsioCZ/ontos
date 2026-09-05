import { Effect, Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;
declare const resolve: (id: string) => Effect.Effect<string>;
declare const program: Effect.Effect<number>;

/** A1 target: one host runtime captured at the seam, then used by forced Promise adapters. */
const runtime = ManagedRuntime.make(appLayer);

export const resolveForSession = (id: string): Promise<string> => runtime.runPromise(resolve(id));

export const forked = runtime.runFork(program);
