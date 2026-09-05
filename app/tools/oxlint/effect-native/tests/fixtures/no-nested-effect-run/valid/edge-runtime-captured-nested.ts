// The allowed target shape, nested as deep as the S1 sandwich: context captured once.
import { Effect } from "effect";

declare const db: { transaction: (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> };
declare const body: (t: unknown) => Effect.Effect<number>;

export const bridge = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  return yield* Effect.tryPromise({
    catch: (error: unknown) => new Error(String(error)),
    try: async () =>
      await db.transaction(async (t) => {
        const first = await Effect.runPromiseExitWith(context)(body(t));
        const second = await Effect.runSyncExitWith(context)(body(t));
        return [first, second];
      }),
  });
});
