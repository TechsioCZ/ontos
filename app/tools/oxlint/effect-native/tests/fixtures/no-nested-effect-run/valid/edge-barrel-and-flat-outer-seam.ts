// Root-barrel namespace imports and flat named imports of the run functions are recognised, but at
// the outer seam they must stay silent. A local binding that shadows a flat run import is not a run
// site either.
import * as effect from "effect";
import { runPromise, runSync } from "effect/Effect";

declare const program: effect.Effect.Effect<number>;

export const main = async (): Promise<number> => await runPromise(program);

export const eager = runSync(program);

export const seam = effect.Effect.runPromise(program);

export const shadowed = effect.Effect.sync(() => {
  const runSync = (value: unknown): unknown => value;
  return runSync(program);
});
