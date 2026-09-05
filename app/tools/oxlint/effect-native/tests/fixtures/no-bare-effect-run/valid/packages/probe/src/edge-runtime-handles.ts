import { Effect, Layer, ManagedRuntime, Runtime } from 'effect';

declare const appLayer: Layer.Layer<never>;
declare const program: Effect.Effect<number>;
declare const handle: Runtime.Runtime<never>;

/** Every prescribed replacement goes through a captured runtime handle. */
export const value = ManagedRuntime.make(appLayer).runSync(program);

export const promised = Runtime.runPromise(handle)(program);

export const forked = Runtime.runFork(handle);
