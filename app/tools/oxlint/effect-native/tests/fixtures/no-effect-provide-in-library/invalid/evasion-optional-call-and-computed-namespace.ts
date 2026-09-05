// expect-count: 3
// Optional calls, computed access on a submodule namespace import, and a parenthesised namespace.
import { Effect, pipe } from "effect";
import * as EffectNs from "effect/Effect";

declare const RequirementsLayer: never;
declare const Clock: never;
declare const clock: never;
declare const program: Effect.Effect<string, never, never>;

export const a = Effect.provide?.(program, RequirementsLayer);

export const b = pipe(program, EffectNs["provideService"](Clock, clock));

export const c = (Effect).provide(program, RequirementsLayer);
