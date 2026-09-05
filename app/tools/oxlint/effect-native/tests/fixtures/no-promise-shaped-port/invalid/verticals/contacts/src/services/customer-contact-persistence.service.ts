// expect-count: 3
import { Effect } from "effect";

const executor = { insert: (rows: readonly string[]) => Promise.resolve(rows) };

/** Non-async but explicitly Promise-returning implementations are the same port shape. */
export const persistence = {
	insertAll: (rows: readonly string[]): Promise<readonly string[]> => executor.insert(rows),
	// nested async inside a reported async is NOT re-reported (one finding per seam)
	loadAll: async () => {
		const inner = { fetch: async () => await executor.insert([]) };
		return inner;
	},
};

export function listContacts(): Promise<readonly string[]> {
	return Effect.runPromise(Effect.succeed([] as readonly string[]));
}
