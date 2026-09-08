// expect-count: 1
// `.cts` must be linted like any other library module.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;

export const leaked = Effect.provide(program, RequirementsLayer);
