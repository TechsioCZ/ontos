// expect-count: 4
/** Evasion: the Promise-shaped service record is built anywhere inside a driver-callback subtree,
 *  which `atDriverEdge` blesses to an unbounded depth. Only the callback itself is forced. */
const ready = Promise.resolve({ delete: (_id: string) => Promise.resolve(), load: (_id: string) => Promise.resolve("x") });
const database = { transaction: <A>(run: (tx: unknown) => Promise<A>) => run({}) };

export const scopedTransactionStore = ready.then((db) => ({
	deleteRecovery: async (id: string) => {
		await db.delete(id);
	},
	loadRecovery: async (id: string) => await db.load(id),
}));

export const transactionalStore = database.transaction(async () => {
	const steps = {
		insertRecovery: async (id: string) => {
			await Promise.resolve(id);
		},
		loadExpiredRecovery: async (id: string) => await Promise.resolve(id),
	};
	return steps;
});
