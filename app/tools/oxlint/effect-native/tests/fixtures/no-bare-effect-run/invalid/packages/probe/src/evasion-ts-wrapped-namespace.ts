// expect-count: 3
import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

/** TS expression wrappers around the namespace must not hide the run entry point. */
export const asCast = (Effect as typeof Effect).runSync(program);

export const nonNull = Effect!.runFork(program);

export const parenthesised = (Effect).runSync(program);
