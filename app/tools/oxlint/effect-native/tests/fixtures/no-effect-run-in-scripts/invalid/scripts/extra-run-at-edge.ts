// expect-count: 1
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const loadDatabase = Effect.succeed({ url: "postgres://localhost/ontos" });
const loadSpice = Effect.succeed({ endpoint: "localhost:50051" });

// `migrate` is the executable edge, but it starts two root fibers instead of composing one Effect.
export const migrate = async (): Promise<{ database: unknown; spice: unknown }> => {
	const [database, spice] = await Promise.all([Effect.runPromise(loadDatabase), Effect.runPromise(loadSpice)]);
	return { database, spice };
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await migrate();
	console.log(result);
}
