import { Effect } from 'effect';

/**
 * Runs fixture deletions in call order so every child row drops before its parent, failing on
 * the first deletion that fails. Callers build the delete Effects inline, which keeps the
 * owned table order explicit at the call site instead of behind a generic cascade.
 */
export const purgeFixtureRows = <A, E>(
  deletions: readonly Effect.Effect<A, E>[],
): Effect.Effect<void, E> => Effect.all(deletions, { concurrency: 1, discard: true });
