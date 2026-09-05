import { Effect } from "effect";
import { Pool } from "pg";
import { pathToFileURL } from "node:url";

class QueryFailure extends Error {
	readonly _tag = "QueryFailure";
}

const toFailure = (cause: unknown): QueryFailure => new QueryFailure(String(cause));

const loadContexts = (connectionString: string) =>
	Effect.tryPromise({
		catch: toFailure,
		// Driver edge: the Promise seam Drizzle/pg forces on us, contained in one Effect.
		try: async () => {
			const pool = new Pool({ connectionString });
			try {
				return await pool.query("select 1");
			} finally {
				await pool.end();
			}
		},
	});

const main = Effect.gen(function* () {
	const result = yield* loadContexts("postgres://localhost/ontos");
	yield* Effect.log("loaded", { rows: result.rowCount });
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// The single outer process-exit adapter (audit: "Existing patterns to preserve").
	const exit = await Effect.runPromiseExit(main);
	console.log(exit);
}
