import { Effect } from "effect";

const program = Effect.succeed(1);

// A top-level IIFE is the same single process-exit adapter, spelled differently.
void (async () => {
	const value = await Effect.runPromise(program);
	console.log(value);
})();
