// expect-count: 2
import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

/** Destructuring the namespace hides the member expression but still starts a fresh root fiber. */
const { runSync } = Effect;
const { runPromise: toPromise } = Effect;

export const value = runSync(program);

export const promised = (): Promise<number> => toPromise(program);
