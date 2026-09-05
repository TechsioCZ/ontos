// expect-count: 2
import * as Fx from 'effect';

declare const program: Fx.Effect.Effect<number>;

/** Whole-package namespace import: `Fx.Effect` is still the Effect namespace. */
export const value = Fx.Effect.runSync(program);

export const promised = (): Promise<number> => Fx.Effect.runPromise(program);
