// False-positive guard: a CLI script whose top-level guard dispatches one of several mutually
// exclusive modes. Exactly one root fiber ever starts, and every run site is at the executable
// edge, but the second syntactic site is reported as `extraRun` ("this script already runs an
// Effect at its executable edge ... starts a second root fiber"), which is not true of this code,
// and the suggested fix (Effect.all) would change the semantics from dispatch to fan-out.
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

declare const prepare: Effect.Effect<void>;
declare const verify: Effect.Effect<void>;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv[2] === "prepare") {
		await Effect.runPromise(prepare);
	} else {
		await Effect.runPromise(verify);
	}
}
