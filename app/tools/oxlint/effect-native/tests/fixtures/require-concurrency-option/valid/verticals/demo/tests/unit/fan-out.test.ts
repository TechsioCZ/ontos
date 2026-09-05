import { Effect } from 'effect';

declare const attempts: readonly Effect.Effect<number>[];
declare const items: readonly string[];
declare const run: (value: string) => Effect.Effect<number>;

// Tests deliberately race work to prove concurrency behaviour (audit B2, not B1).
export const proof = Effect.all(attempts, { concurrency: 'unbounded' });
export const sequential = Effect.forEach(items, run);
