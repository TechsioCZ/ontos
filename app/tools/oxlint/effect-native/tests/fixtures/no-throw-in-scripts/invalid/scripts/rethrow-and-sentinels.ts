// expect-count: 7
const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

class MigrationAborted {
	readonly _tag = "MigrationAborted";
}

async function run(): Promise<void> {
	await Promise.resolve();
}

export async function migrate(): Promise<void> {
	try {
		await run();
	} catch (error) {
		throw error;
	}
}

export async function migrateAgain(): Promise<void> {
	try {
		await run();
	} catch ({ cause }) {
		throw cause;
	}
}

export function validate(topology: { readonly verticals: readonly string[] }): void {
	if (topology.verticals.length === 0) {
		throw failure("local_contract_invalid", "The authoritative topology has no MicroVerticals");
	}
	if (new Set(topology.verticals).size !== topology.verticals.length) {
		throw failure("local_contract_invalid", "The authoritative topology has duplicate verticals");
	}
	throw new MigrationAborted();
}

export function unwrap(result: { readonly error?: unknown }): void {
	if (result.error !== undefined) throw result.error;
	throw "unreachable";
}
