/**
 * False positive reproduction — same class as `fp-run-promise-continuation-adapter.mts`, reduced to
 * module-evaluation code with no `main` at all.
 *
 * The single exit adapter is the `.then()` continuation of a top-level `Effect.runPromiseExit`; it
 * is the only exit site in the file and it runs at the executable edge. `isEntryPosition` only
 * accepts module-evaluation code, a top-level IIFE, or a Program-level `main`, so any promise
 * continuation of the edge run is reported as `exitInsideFunction`.
 */
import { Effect, Exit } from "effect";

void Effect.runPromiseExit(Effect.succeed(0)).then((outcome) => {
	process.exitCode = Exit.match(outcome, { onFailure: () => 1, onSuccess: () => 0 });
});
