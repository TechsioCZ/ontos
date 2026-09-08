// expect-count: 1
// Exporting a library runner without invoking it at module evaluation is not a process seam.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;

export async function main(): Promise<void> {
  await Effect.runPromise(program.pipe(Effect.provide(RequirementsLayer)));
}
