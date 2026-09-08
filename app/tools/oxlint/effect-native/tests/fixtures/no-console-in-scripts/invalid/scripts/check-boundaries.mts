// expect-count: 4
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
const failures: readonly string[] = [];

export function reportFailures(): void {
	console.warn("Database access boundary drift detected");
	console["error"](`- ${String(failures.length)} violations`);
	console?.debug?.("verbose boundary trace");
	(console).table(failures);
	globalThis.console.log("Database access boundaries verified");
	console.trace("boundary check call site");
}
