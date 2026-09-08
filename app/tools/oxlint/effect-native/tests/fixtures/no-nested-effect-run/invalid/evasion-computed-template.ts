// expect-count: 1
// A no-substitution template literal is a static computed member access.
import { Effect } from "effect";

declare const program: Effect.Effect<number>;

export const eager = Effect.sync(() => Effect[`runPromise`](program));
