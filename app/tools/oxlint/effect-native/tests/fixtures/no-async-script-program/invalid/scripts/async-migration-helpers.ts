// expect-count: 5
import { Effect } from "effect";
import { Pool } from "pg";

// B3: the whole script is a Promise program — no typed failures, no Scope for the pool.
const loadContexts = async (connectionString: string): Promise<readonly unknown[]> => {
	const pool = new Pool({ connectionString });
	try {
		return (await pool.query("select 1")).rows as readonly unknown[];
	} finally {
		await pool.end();
	}
};

export async function migrateContactsAuthorization(connectionString: string): Promise<void> {
	const contexts = await loadContexts(connectionString);
	console.log(contexts.length);
}

async function* streamRows(): AsyncGenerator<number> {
	yield 1;
}

class MigrationRunner {
	async run(): Promise<void> {
		await migrateContactsAuthorization("postgres://localhost/ontos");
	}
}

const runners = {
	async bootstrap(): Promise<void> {
		await new MigrationRunner().run();
	},
};

void streamRows;
void runners;
void Effect.void;
