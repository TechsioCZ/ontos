// expect-count: 2
// Renamed and computed-key destructuring of the Effect namespace.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

const { runPromise: go, ["runSync"]: now } = Effect;

export const a = Effect.sync(() => {
  void go(program);
});

export const b = Effect.sync(() => now(program));
