// expect-count: 2
import { Effect as E } from 'effect';

declare const program: E.Effect<number>;

/** Re-binding the namespace to a local hides the tracked import name. */
const Fx = E;

export const value = Fx.runSync(program);

export const promised = (): Promise<number> => Fx.runPromise(program);
