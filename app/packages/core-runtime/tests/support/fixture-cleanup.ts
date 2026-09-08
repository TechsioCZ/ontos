import { Effect } from 'effect';
import { runEffectTestPromise } from './effect-runtime.ts';

/**
 * Runs fixture deletions in call order so every child row drops before its parent, failing on
 * the first deletion that rejects. Callers build the delete Effects inline, which keeps the
 * owned table order explicit at the call site instead of behind a generic cascade.
 */
export const purgeFixtureRows = <A, E>(deletions: readonly Effect.Effect<A, E>[]): Promise<void> =>
  runEffectTestPromise(Effect.all(deletions, { discard: true }));
