// expect-count: 1
// B3/S1: a single syntactic run site inside the entrypoint, but one root fiber per tenant.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const tenants = ["akros", "ontos"];

const main = async (): Promise<void> => {
	for (const tenant of tenants) {
		await Effect.runPromise(Effect.succeed(tenant));
	}
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
