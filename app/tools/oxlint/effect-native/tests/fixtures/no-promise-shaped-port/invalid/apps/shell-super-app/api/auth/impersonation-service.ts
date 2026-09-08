// expect-count: 7
/** A5 evidence shape: a Promise-shaped first-party port and its async implementation. */
export interface SupportImpersonationStore {
	readonly deleteRecovery: (id: string) => Promise<void>;
	loadRecovery(id: string): Promise<string>;
	readonly ready: Promise<void>;
}

export type RevokeSession = (sessionId: string) => Promise<boolean>;

export interface StoreFactory {
	(): Promise<SupportImpersonationStore>;
	new (): Promise<SupportImpersonationStore>;
}

const db = { delete: (_id: string) => Promise.resolve() };

export const supportImpersonationStore = {
	deleteRecovery: async (id: string) => {
		await db.delete(id);
	},
};
