// expect-count: 2
/** Evasion: service members named like framework router entrypoints (`allowNames`) are not router entrypoints. */
const db = { delete: (_id: string) => Promise.resolve() };

export const actionAuthorizationStore = {
	action: async (id: string) => {
		await db.delete(id);
	},
	async middleware(id: string) {
		await db.delete(id);
	},
};
