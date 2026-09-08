// expect-count: 3
// S1: the Effect -> Promise -> Effect transaction sandwich from actions/runtime.ts.
import { Effect } from "effect";

declare const db: { transaction: (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> };
declare const repo: { lock: (t: unknown, id: string) => Effect.Effect<string> };
declare const verify: (value: string) => Effect.Effect<void>;

export const runTransaction = (id: string) =>
  Effect.tryPromise({
    catch: (error: unknown) => new Error(String(error)),
    try: async () =>
      await db.transaction(async (t) => {
        const locked = await Effect.runPromiseExit(repo.lock(t, id));
        await Effect.runPromiseExit(verify(String(locked)));
        return locked;
      }),
  });

export const cleanup = Effect.sync(() => {
  void Effect.runPromise(verify("x"));
});
