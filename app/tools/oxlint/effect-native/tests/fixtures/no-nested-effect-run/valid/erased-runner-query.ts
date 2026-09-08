import { Effect } from 'effect';
import type { runPromise } from 'effect/Effect';
export const program = Effect.sync(() => {
  type Runner = typeof runPromise;
  type SyncRunner = typeof Effect.runSync;
  return undefined;
});
