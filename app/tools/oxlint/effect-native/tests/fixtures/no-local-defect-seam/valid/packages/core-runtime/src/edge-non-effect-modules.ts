// Same member names from modules that are not `effect` / `effect/*` / a blessed re-export barrel.
import { Cause } from '@effect/platform';
import { Effect } from 'effect-mock';
import { hasDies } from './cause-helpers.ts';

declare const cause: never;
declare const program: never;

export const a = Cause.hasDies(cause);
export const b = Effect.catchDefect(program, () => program);
export const c = hasDies(cause);
