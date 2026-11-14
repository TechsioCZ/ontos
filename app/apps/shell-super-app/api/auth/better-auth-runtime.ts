import { Context, Effect, Function as Fn, Layer, Option } from 'effect';

import type { ShellBetterAuth } from './better-auth-provider-types.ts';
import { AUTH_OPERATION_TIMEOUT_MS } from './observability.ts';

export class BetterAuthRuntime extends Context.Service<
  BetterAuthRuntime,
  {
    readonly getOrCreate: (key: string, create: () => ShellBetterAuth) => ShellBetterAuth;
  }
>()('@app/shell-super-app/api/auth/better-auth-runtime/BetterAuthRuntime') {}

/** Install once per isolate. Only ready instances are shared: Worker I/O belongs to the request that started it. */
export const BetterAuthRuntimeLive = Layer.effect(
  BetterAuthRuntime,
  Effect.gen(function* betterAuthRuntime() {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context();
    const ready = new Map<string, ShellBetterAuth>();
    return {
      getOrCreate: (key, create) => {
        const existing = ready.get(key);
        if (existing !== undefined) {
          return existing;
        }
        const created = create();
        // Observe only the SDK-owned setup Promise. Its original failure still belongs to dispatch;
        // failed or timed-out setup is never published, and this observer starts no database work.
        Effect.runCallbackWith(context)(
          Effect.tryPromise(Fn.constant(created.$context)).pipe(
            Effect.timeoutOption(AUTH_OPERATION_TIMEOUT_MS),
            Effect.match({
              onFailure: Fn.constVoid,
              onSuccess: (setup) => {
                if (Option.isSome(setup) && !ready.has(key)) {
                  if (ready.size >= 4) {
                    ready.clear();
                  }
                  ready.set(key, created);
                }
              },
            }),
            Effect.forkIn(scope),
          ),
        );
        return created;
      },
    };
  }),
);
