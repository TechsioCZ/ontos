import { Effect, Exit } from "effect";
import { pathToFileURL } from "node:url";

const loadDatabase = Effect.succeed({ url: "postgres://localhost/ontos" });
const loadSpice = Effect.succeed({ endpoint: "localhost:50051" });

export function main(): Effect.Effect<{ database: unknown; spice: unknown }> {
	return Effect.gen(function* () {
		const [database, spice] = yield* Effect.all([loadDatabase, loadSpice], { concurrency: 2 });
		return { database, spice };
	});
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const exit = await Effect.runPromiseExit(main());
	process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
