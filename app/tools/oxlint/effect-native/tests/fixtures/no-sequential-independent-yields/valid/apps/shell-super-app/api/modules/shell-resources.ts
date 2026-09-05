// The B1 target shape (`Effect.all` with a bound) plus `Context.Service` acquisition, which the
// audit's "Existing patterns to preserve" section blesses. Neither is ever reported.
import { Effect } from 'effect';

declare const AuthConfig: Effect.Effect<{ readonly url: string }>;
declare const AuthDatabase: Effect.Effect<{ readonly ping: () => void }>;
declare const PrincipalResolver: Effect.Effect<{ readonly resolve: () => void }>;
declare const moduleStates: { readonly get: (ids: readonly string[]) => Effect.Effect<readonly string[]> };
declare const contextAccess: { readonly modules: (ids: readonly string[]) => Effect.Effect<readonly string[]> };

export const search = (ids: readonly string[]) =>
  Effect.gen(function* () {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    const [states, permissions] = yield* Effect.all(
      [moduleStates.get(ids), contextAccess.modules(ids)],
      { concurrency: 2 },
    );
    return { configuration, database, permissions, resolver, states };
  });
