// expect-count: 1
// `.mts` scripts tests use top-level await; the rule must still see the run site.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

export const value = await Effect.runPromise(program);
