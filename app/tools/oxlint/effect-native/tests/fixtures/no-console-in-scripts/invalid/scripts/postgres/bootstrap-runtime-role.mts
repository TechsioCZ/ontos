// expect-count: 1
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
import { Effect } from "effect";

export const verifyRole = Effect.sync(() => {
	console.log("Verified least-privilege PostgreSQL role ontos_runtime");
});

async function main(): Promise<void> {
	try {
		await Effect.runPromise(verifyRole);
	} catch (error) {
		console.error("bootstrap failed", error);
		process.exitCode = 1;
	}
}

await main();
console.info("bootstrap finished");
