// expect-count: 1
// A one-hop local alias of the imported namespace still resolves to the effect import.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

const E = Effect;

export const run = (): Promise<string> => E.runPromise(program);
