// expect-count: 3
/** Async generators, computed keys and getters are still Promise-shaped service members. */
const db = { load: (_id: string) => Promise.resolve("x") };

export const customerContactPersistence = {
	async *pages(): AsyncGenerator<string> {
		yield await db.load("a");
	},
	["deleteRecovery"]: async (id: string) => {
		await db.load(id);
	},
	get ready(): Promise<void> {
		return Promise.resolve();
	},
};
