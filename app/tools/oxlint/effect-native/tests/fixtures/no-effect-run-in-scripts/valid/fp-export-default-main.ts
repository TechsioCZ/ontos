// False-positive guard: same executable edge as valid/scripts/main-invoked-from-guard.ts, but the
// entrypoint is also `export default`-ed (a shape already used by scripts/scaffolding/*/scaffold.mts).
// The single run site at the edge is reported as `nestedRun`.
import { Effect } from "effect";

declare const program: Effect.Effect<void>;

function main(): Promise<void> {
	return Effect.runPromise(program);
}

await main();

export default main;
