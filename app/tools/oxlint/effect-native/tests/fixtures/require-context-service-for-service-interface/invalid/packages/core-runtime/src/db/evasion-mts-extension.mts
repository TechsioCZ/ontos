// expect-count: 1
import { Effect } from 'effect';

/** `.mts` module source is in scope exactly like `.ts` (only `*.config.mts` is ignored). */
export interface ConnectionPoolRepository {
  readonly acquire: () => Effect.Effect<string, Error>;
}

export const acquire = (repository: ConnectionPoolRepository): Effect.Effect<string, Error> =>
  repository.acquire();
