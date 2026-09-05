// expect-count: 4
import { Effect, pipe } from 'effect';

declare const program: Effect.Effect<number>;

export const toPromise = <A>(effect: Effect.Effect<A>): Promise<A> => pipe(effect, Effect.runPromise);

export const run = Effect.runPromise;

export const exit = Effect.runPromiseExit(program);

export const value = Effect['runSync'](program);
