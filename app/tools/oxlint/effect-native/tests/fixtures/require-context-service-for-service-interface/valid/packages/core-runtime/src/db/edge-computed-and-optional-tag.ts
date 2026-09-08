import { Context, Effect } from 'effect';

export interface LedgerRepositoryPort {
  readonly post: (entry: string) => Effect.Effect<void, Error>;
}

/** Computed string-literal member access is still `Context.Service`. */
export class LedgerRepository extends Context['Service']<LedgerRepository, LedgerRepositoryPort>()(
  '@app/core-runtime/db/LedgerRepository',
) {}

export interface LedgerReadModelPort {
  readonly read: (id: string) => Effect.Effect<string, Error>;
}

/** Optional chaining around the same tag factory. */
export const LedgerReadModel = Context?.GenericTag<LedgerReadModelPort>(
  '@app/core-runtime/db/LedgerReadModel',
);
