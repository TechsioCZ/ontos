// expect-count: 1
import { Effect } from 'effect';

export const makeIdentityLifecycleService = (seed: string) => ({
  setStatus: (status: string): Effect.Effect<void> => Effect.log(`${seed}:${status}`),
});

/** `ReturnType<typeof make…>` alias with no tag in the module. */
export type IdentityLifecycleService = ReturnType<typeof makeIdentityLifecycleService>;
