// expect-count: 2
// Scope covers tests too: nested re-entry inside an Effect-owned harness is still S1.
import { Effect, Layer } from "effect";

declare const Tag: never;
declare const seed: () => Effect.Effect<void>;
declare const program: Effect.Effect<number>;

export const seedLayer = Layer.effect(
  Tag,
  Effect.sync(() => {
    void Effect.runPromise(seed());
  }),
);

export const value = Effect.gen(function* () {
  const eager = Effect.runSync(program);
  return yield* Effect.succeed(eager);
});
