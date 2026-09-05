/**
 * False positive reproduction — `scripts/provision-current-action-authorization.mts:294`.
 *
 * This is the audit's blessed shape: ONE outer process adapter seam (audit "Existing patterns to
 * preserve": "Bare `Effect.runPromise` is acceptable at the single outer process or framework
 * adapter seam") writing a NON-terminating `process.exitCode` at the executable edge — `main` is
 * Program-level and only ever invoked from the `import.meta.url` guard.
 *
 * The rule reports `exitInsideFunction` because the write sits in the `.catch()` continuation of the
 * entry-level `Effect.runPromise`, and the message claims the site "terminates the process ... so
 * Scope finalizers ... never run". Setting `process.exitCode` terminates nothing: Node drains the
 * event loop and runs finalizers exactly as it does for the blessed
 * `process.exitCode = Exit.match(...)` spelling in `single-exit-adapter.mts`.
 */
import { Effect } from "effect";
import { pathToFileURL } from "node:url";

const program = Effect.succeed("provisioned" as const);

const main = (): void => {
	Effect.runPromise(program)
		.then((result) => {
			console.log(result);
		})
		.catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
