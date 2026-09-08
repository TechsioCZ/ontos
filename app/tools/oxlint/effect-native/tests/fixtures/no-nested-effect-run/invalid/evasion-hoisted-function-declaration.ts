// expect-count: 2
// The extracted-callback evasion in its other two spellings: a hoisted `function` declaration and a
// two-hop chain (helper -> factory -> Effect.gen). Both are the S1 re-entry with one rename away.
import { Effect } from "effect";

declare const db: { transaction: (fn: () => Promise<unknown>) => Promise<unknown> };
declare const program: Effect.Effect<number>;

async function commit(): Promise<unknown> {
  return await Effect.runPromiseExit(program);
}

export const bridge = Effect.tryPromise({
  catch: (error: unknown) => new Error(String(error)),
  try: () => db.transaction(commit),
});

const seedAll = (): void => {
  void Effect.runPromise(program);
};

const makeService = () => ({ seed: () => seedAll() });

export const service = Effect.sync(() => makeService());
