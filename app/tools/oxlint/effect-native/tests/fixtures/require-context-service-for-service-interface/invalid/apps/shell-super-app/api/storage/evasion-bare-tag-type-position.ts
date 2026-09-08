// expect-count: 1
import { Effect } from 'effect';
import { Tag } from 'effect/Context';

/** `Tag` is referenced only as a *type* here — no tag is ever constructed in this module. */
export type AnyRepositoryTag = Tag<unknown, unknown>;

export interface DocumentStorageRepository {
  readonly read: (key: string) => Promise<string>;
}

export const read = (repository: DocumentStorageRepository): Effect.Effect<string, Error> =>
  Effect.promise(() => repository.read('key'));
