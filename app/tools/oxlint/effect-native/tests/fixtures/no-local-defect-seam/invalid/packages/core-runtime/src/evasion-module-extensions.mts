// expect-count: 2
// `.mts` under packages/** is production source too.
import * as Effect from 'effect/Effect';
import * as Cause from 'effect/unstable/tracing/Cause';

declare const program: never;
declare const cause: never;

export const swallowed = Effect.catchDefect(program, () => program);
export const dies = Cause.hasDies(cause);
