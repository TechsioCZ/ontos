// expect-count: 1
// B3/A1: the single edge run is fine, but the cleanup hangs off the *Promise*, outside the program.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

declare const pool: { readonly end: () => Promise<void> };
declare const migration: Effect.Effect<void>;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await Effect.runPromise(migration).finally(async () => {
		await pool.end();
	});
}
