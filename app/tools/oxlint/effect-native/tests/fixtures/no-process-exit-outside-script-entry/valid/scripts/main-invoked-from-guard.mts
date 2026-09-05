import { Effect, Exit } from "effect";
import { pathToFileURL } from "node:url";

const main = async (): Promise<void> => {
	const outcome = await Effect.runPromiseExit(Effect.succeed(0));
	process.exitCode = Exit.isSuccess(outcome) ? 0 : 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
