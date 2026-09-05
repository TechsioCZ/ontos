// Point-free run at the outer adapter seam is not re-entry and must stay silent.
import { Effect, pipe } from "effect";

declare const program: Effect.Effect<number>;
declare const jobs: ReadonlyArray<Effect.Effect<number>>;

export const runAll = (): ReadonlyArray<Promise<number>> => jobs.map(Effect.runPromise);

export const runOne = (): number => pipe(program, Effect.runSync);
