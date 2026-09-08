// expect-count: 1
// `Effect.fn("name")(body)` — the owning call is the result of an Effect member call.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

export const handler = Effect.fn("handler")(function* () {
  const value = Effect.runSync(program);
  return yield* Effect.succeed(value);
});
