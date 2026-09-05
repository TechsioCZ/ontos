import { Effect, Exit } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed("done" as const);

// Audit "existing patterns to preserve": one process-exit adapter at the executable edge.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const outcome = await Effect.runPromiseExit(program);
	process.exitCode = Exit.match(outcome, { onFailure: () => 1, onSuccess: () => 0 });
}
