// expect-count: 2
import * as Fx from 'effect';

declare const program: Fx.Effect.Effect<number>;

/** Two hops: package namespace → Effect namespace → destructured entry point. */
const { Effect } = Fx;
const { runSync, runFork } = Effect;

export const value = runSync(program);

export const forked = runFork(program);
