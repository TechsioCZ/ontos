// expect-count: 2
import { Effect } from "@modern-js/bff-effect/effect-edge";

declare const load: () => Effect.Effect<string>;

export const boot = Effect.gen(function* () {
  const eager = Effect.runSync(load());
  return yield* Effect.succeed(eager);
});

export const nested = Effect.tryPromise({
  catch: (error: unknown) => new Error(String(error)),
  try: async () => await Effect.runPromise(load()),
});
