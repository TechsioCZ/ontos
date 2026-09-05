// Lookalike: `Effect` here is a function parameter, not the `effect` import. The rule must resolve
// the namespace identifier through scope before reporting.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed(1);

interface FakeRunner {
	readonly runPromise: (value: number) => Promise<number>;
}

async function withLocalRunner(Effect: FakeRunner): Promise<number> {
	return await Effect.runPromise(1);
}

void withLocalRunner;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await Effect.runPromise(program);
}
