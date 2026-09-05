import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

/** Tests are B2 territory (`itEffect` harness), not A1. */
export const value = Effect.runSync(program);
