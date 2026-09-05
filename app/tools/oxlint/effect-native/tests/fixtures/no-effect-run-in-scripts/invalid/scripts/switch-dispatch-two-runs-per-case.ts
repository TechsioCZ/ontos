// expect-count: 1
// B3/S1: mode dispatch is fine (the cases are mutually exclusive), but one case starts two root
// fibers, so the second one is the extra run that must be composed into the first program.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

declare const prepare: Effect.Effect<void>;
declare const verify: Effect.Effect<void>;
declare const finalize: Effect.Effect<void>;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	switch (process.argv[2]) {
		case "prepare": {
			await Effect.runPromise(prepare);
			await Effect.runPromise(verify);
			break;
		}
		default: {
			await Effect.runPromise(finalize);
		}
	}
}
