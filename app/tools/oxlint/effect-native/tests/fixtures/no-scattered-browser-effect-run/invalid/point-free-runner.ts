// expect-count: 5
import * as EffectModule from 'effect/Effect';
import { Effect, pipe } from 'effect';
import { runEffectRequest as runRequest } from '../contacts-api.ts';

declare const program: Effect.Effect<string>;
declare const programs: ReadonlyArray<Effect.Effect<string>>;

export const started = pipe(program, Effect.runPromise);
export const computed = Effect['runSync'](program);
export const forked = EffectModule?.runFork(program);
export const aliased = (value: Effect.Effect<string>) => runRequest(value);
export const deferred = programs.map(runRequest);
