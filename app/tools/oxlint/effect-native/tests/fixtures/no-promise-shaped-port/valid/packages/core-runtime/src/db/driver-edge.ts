/** The blessed driver edge: every Promise lives inside Effect.tryPromise / Effect.promise. */
import { Effect } from "effect";
import * as Eff from "effect/Effect";
import * as E from "effect";
import { tryPromise } from "effect/Effect";

const executor = { insert: (rows: readonly string[]) => Promise.resolve(rows) };
const pool = { end: () => Promise.resolve() };
const db = { transaction: <A>(run: (tx: unknown) => Promise<A>) => run({}) };
const decodeFailure = (cause: unknown) => cause;

export const insertAll = (rows: readonly string[]) =>
	Effect.tryPromise({ catch: decodeFailure, try: async () => await executor.insert(rows) });

export const shutdown = Effect.promise(async () => await pool.end());

export const aliased = Eff.tryPromise({ catch: decodeFailure, try: async () => await executor.insert([]) });

export const barrel = E.Effect.tryPromise({ catch: decodeFailure, try: async () => await executor.insert([]) });

export const bare = tryPromise({ catch: decodeFailure, try: async () => await executor.insert([]) });

export const optional = Effect?.tryPromise({ catch: decodeFailure, try: async () => await executor.insert([]) });

/** Drizzle forces the transaction callback to be a Promise (audit D tier). */
export const inTransaction = Effect.tryPromise({
	catch: decodeFailure,
	try: () => db.transaction(async (tx) => await executor.insert([String(tx)])),
});

export const chained = Effect.promise(() => pool.end().then(async () => await executor.insert([])));
