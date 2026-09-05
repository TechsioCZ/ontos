import { Effect } from 'effect-http-lookalike';
import { runSync } from './effect/Effect.ts';

declare const program: unknown;

/** Neither module is `effect`; these are unrelated third-party/local helpers. */
export const value = Effect.runPromise(program);

export const eager = runSync(program);
