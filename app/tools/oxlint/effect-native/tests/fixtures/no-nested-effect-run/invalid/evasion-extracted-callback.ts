// expect-count: 1
// The S1 sandwich after one trivial refactor: the transaction callback is hoisted to a module-level
// const and passed by name. The re-entry is unchanged, but the run site no longer sits syntactically
// under the `Effect.tryPromise` arguments.
import { Effect } from "effect";

declare const db: { transaction: (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> };
declare const repo: { lock: (t: unknown, id: string) => Effect.Effect<string> };

const body = async (t: unknown): Promise<unknown> => await Effect.runPromiseExit(repo.lock(t, "id"));

export const runTransaction = Effect.tryPromise({
  catch: (error: unknown) => new Error(String(error)),
  try: () => db.transaction(body),
});
