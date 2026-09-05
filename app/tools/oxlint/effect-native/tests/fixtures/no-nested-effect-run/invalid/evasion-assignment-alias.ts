// expect-count: 1
// Alias bound through an assignment rather than a declarator initialiser.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

let run: (effect: Effect.Effect<number>) => Promise<number>;
run = Effect.runPromise;

export const layer = Effect.sync(() => {
  void run(program);
});
