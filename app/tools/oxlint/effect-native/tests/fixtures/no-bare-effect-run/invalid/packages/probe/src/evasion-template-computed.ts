// expect-count: 2
import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

/** Template-literal computed access is the sibling of the string-literal form the rule already catches. */
export const value = Effect[`runSync`](program);

export const forked = Effect?.[`runFork`](program);
