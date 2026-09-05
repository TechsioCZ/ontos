// expect-count: 5
import { Effect } from 'effect';

declare const db: { select: () => { from: (table: string) => Promise<readonly unknown[]> } };
declare const client: { checkPermission: (request: string) => Promise<boolean> };
declare const table: string;

const toPersistenceError = (cause: unknown) => new Error(String(cause));

// 1 — the audit's canonical unbounded persistence bridge.
export const listRows = Effect.gen(function* () {
  const rows = yield* Effect.tryPromise({ catch: toPersistenceError, try: () => db.select().from(table) });
  return rows;
});

// 2 — point-free bridge whose only pipe stage is an error mapper, not a policy.
export const check = (request: string) =>
  Effect.tryPromise(() => client.checkPermission(request)).pipe(Effect.mapError(toPersistenceError));

// 3 — `Effect.promise` has no failure channel *and* no bound.
export const fireAndForget = Effect.promise(async () => await client.checkPermission('x'));

// 4 — data-first bridge.
export const mapped = Effect.tryMapPromise(fireAndForget, {
  catch: toPersistenceError,
  try: (value: boolean) => client.checkPermission(String(value)),
});

// 5 — nested inside a generator that installs no policy of its own.
export const nested = Effect.gen(function* () {
  yield* Effect.tryPromise({ catch: toPersistenceError, try: () => db.select().from(table) });
});
