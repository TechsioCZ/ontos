// expect-count: 1
import { Effect } from 'effect';

/** Operation slots declared as an index signature rather than as named members. */
export interface ScopedHandlerRegistryPort {
  readonly [operation: string]: (input: string) => Effect.Effect<void, Error>;
}

export const runHandler = (registry: ScopedHandlerRegistryPort): Effect.Effect<void, Error> =>
  registry['load']('x');
