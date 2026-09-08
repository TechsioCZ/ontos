// expect-count: 3
/** Evasion: the async implementation hides behind `as` / `satisfies` / a parenthesised cast. */
const db = { delete: (_id: string) => Promise.resolve() };

export const supportImpersonationStore = {
	deleteRecovery: (async (id: string) => {
		await db.delete(id);
	}) as (id: string) => Promise<void>,
	deleteSession: (async (id: string) => {
		await db.delete(id);
	}) satisfies (id: string) => Promise<void>,
};

export const revokeSession = (async (id: string) => {
	await db.delete(id);
}) as (id: string) => Promise<void>;
