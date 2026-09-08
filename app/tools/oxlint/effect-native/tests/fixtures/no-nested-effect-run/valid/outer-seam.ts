// D tier: bare Effect.runPromise at the single outer process / framework adapter seam is preserved.
import { Effect } from "effect";

declare const program: Effect.Effect<void>;

export const main = async (): Promise<void> => {
  await Effect.runPromise(program);
};

void Effect.runPromise(program);

export const handler = (): Promise<void> => Effect.runPromise(program).catch(() => undefined);

export const pointFree = program.pipe(Effect.runPromise);
