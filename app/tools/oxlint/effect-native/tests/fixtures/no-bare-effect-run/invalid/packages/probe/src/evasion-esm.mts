// expect-count: 1
import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

export const value = Effect.runSync(program);
