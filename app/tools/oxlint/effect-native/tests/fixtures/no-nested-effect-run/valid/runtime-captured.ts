// The S1 target shape: capture the context once, run it at the single Drizzle callback boundary.
import { Effect, Layer, ManagedRuntime } from "effect";

declare const layer: Layer.Layer<never>;
declare const body: (t: unknown) => Effect.Effect<number>;
declare const db: { transaction: (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> };

export const bridge = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  return yield* Effect.tryPromise({
    catch: (error: unknown) => new Error(String(error)),
    try: () => db.transaction((t) => Effect.runPromiseExitWith(context)(body(t))),
  });
});

const runtime = ManagedRuntime.make(layer);

export const kick = Effect.sync(() => {
  void runtime.runPromise(body(undefined));
});
