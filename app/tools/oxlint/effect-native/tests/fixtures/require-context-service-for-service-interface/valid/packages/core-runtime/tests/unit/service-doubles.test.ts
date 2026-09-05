import { Effect } from 'effect';

/** Test doubles are not production service seams (includeTests defaults to false). */
export interface FakeOutboxRepositoryService {
  readonly claim: () => Effect.Effect<readonly string[]>;
}
