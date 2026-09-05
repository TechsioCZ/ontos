import { Effect, pipe as flow } from 'effect';

declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;
declare const zero: Effect.Effect<number>;
declare const combine: (a: number, b: number) => Effect.Effect<number>;

// `pipe` under a local alias is still `pipe`: this operator already declares its bound.
export const reduced = flow([left, right], Effect.reduceEffect(zero, combine, { concurrency: 2 }));
