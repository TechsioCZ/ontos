// D tier: the Node process-exit adapter at the single seam, spelled with try/catch.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed("done");

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		console.log(await Effect.runPromise(program));
	} catch (error: unknown) {
		console.error(error);
		process.exitCode = 1;
	}
}
