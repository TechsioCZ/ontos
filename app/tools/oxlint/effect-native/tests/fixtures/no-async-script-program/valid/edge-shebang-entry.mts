#!/usr/bin/env node
import { Effect } from "effect";

const main = Effect.gen(function* () {
	yield* Effect.log("shebang entry");
});

// The single outer process-exit adapter, under a shebang.
const exit = await Effect.runPromiseExit(main);
process.exitCode = exit._tag === "Success" ? 0 : 1;
