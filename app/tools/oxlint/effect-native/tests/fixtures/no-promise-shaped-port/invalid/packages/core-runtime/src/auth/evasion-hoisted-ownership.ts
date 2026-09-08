// expect-count: 2
/** Evasion: the async member is hoisted out of the record literal, or the module binding lives in a namespace. */
const db = { delete: (_id: string) => Promise.resolve() };

export function makeSupportImpersonationStore() {
	const deleteRecovery = async (id: string) => {
		await db.delete(id);
	};
	return { deleteRecovery };
}

export namespace SupportImpersonation {
	export const revokeSession = async (sessionId: string) => {
		await db.delete(sessionId);
	};
}
