// expect-count: 2
import { Effect } from "effect";

const loadDatabase = Effect.succeed({ url: "postgres://localhost/ontos" });
const loadSpice = Effect.succeed({ endpoint: "localhost:50051" });

// B3: a helper that leaves Effect twice; each call is a fresh root fiber with its own context.
async function collectConfiguration(): Promise<{ database: unknown; spice: unknown }> {
	const [database, spice] = await Promise.all([Effect.runPromise(loadDatabase), Effect.runPromise(loadSpice)]);
	return { database, spice };
}

export async function migrateContactsAuthorization(): Promise<unknown> {
	return await collectConfiguration();
}
