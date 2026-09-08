// Blessed seam: an exported Program-level `main` invoked only from the import.meta.url guard.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed(1);

export async function main(): Promise<void> {
	await Effect.runPromise(program);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
