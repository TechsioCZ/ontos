import { Effect } from "effect";
import { updateService } from "effect/Effect";
declare const program: Effect.Effect<void>;
declare const Clock: never;
// updateService does not discharge R. It is not the local provision described by S1/A1.
export const adjusted = program.pipe(Effect.updateService(Clock, clock => clock));
export const adjustedDirect = program.pipe(updateService(Clock, clock => clock));
