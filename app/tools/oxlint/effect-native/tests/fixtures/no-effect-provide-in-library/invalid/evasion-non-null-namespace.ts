// expect-count: 2
// Evasion: a non-null assertion on the namespace. The rule already unwraps `Effect?.provide` and
// `Effect["provide"]`, but `node.object` is never unwrapped, so `Effect!.provide` is invisible.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const Clock: never;
declare const clock: never;
declare const program: Effect.Effect<string, never, never>;

export const a = Effect!.provide(program, RequirementsLayer);

export const b = program.pipe(Effect!["provideService"](Clock, clock));
