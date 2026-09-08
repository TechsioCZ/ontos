// expect-count: 5
/** Class-shaped port plus module-scope async bindings. */
export class ActionRepository {
	async claimNext(id: string) {
		return await Promise.resolve(id);
	}

	readonly flush = async () => {
		await Promise.resolve();
	};
}

export const loadPrincipal = async (id: string) => await Promise.resolve(id);

export async function insertOutbox(rows: readonly string[]) {
	await Promise.resolve(rows);
}

/** Module-scope helpers count too, exported or not. */
async function flushOutbox() {
	await Promise.resolve();
}
void flushOutbox;
