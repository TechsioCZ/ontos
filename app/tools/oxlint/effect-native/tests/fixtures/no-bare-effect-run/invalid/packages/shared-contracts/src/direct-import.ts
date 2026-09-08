// expect-count: 2
import { Effect } from 'effect';
import { runPromise, runSync } from 'effect/Effect';

declare const program: Effect.Effect<number>;

export const eager = runSync(program);

export const later = (): Promise<number> => runPromise(program);
