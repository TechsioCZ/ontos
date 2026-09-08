import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed(1);

const main = async (): Promise<void> => {
	const value = await Effect.runPromise(program);
	console.log(value);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
