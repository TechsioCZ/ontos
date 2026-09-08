// False positive reproduction (report-only rule; nothing in scripts/ was edited to satisfy it).
//
// Real site: scripts/validate-ultramodern-workspace.mts:5002, 5014, 5024 — 3 `consoleReference`
// diagnostics on the save / patch / restore triple around `nodeFileTrace` (`@vercel/nft`, reached
// through Modern.js `ndepe`).
//
// This is NOT the B3/A6 anti-pattern. The script is not emitting output here; it is *intercepting*
// a third-party library's `console.log` so the validator can assert on what the vendor tracer
// globbed. The diagnostic's prescribed remedy — "install a `Logger.replace(...)` / `Logger.add(...)`
// Layer so the sink is a Layer in the runtime graph" — cannot be applied: `@vercel/nft` is not an
// Effect program, so no Logger Layer can ever observe its output, and removing the patch deletes the
// assertion. The audit's D tier blesses exactly this kind of adapter forced by third-party tooling.
//
// Genuine `consoleReference` hits (a captured `const log = console.log` used as the script's own
// logger, e.g. scripts/setup-agent-reference-repos.mts:26) must keep reporting; only the
// save/patch/restore interception triple should be exempt (or gated behind an option).
declare function nodeFileTrace(files: readonly string[]): Promise<unknown>;
declare function assert(condition: boolean, message: string): void;

export async function proveTracerRejectsSystemGlobs(entry: string): Promise<void> {
	const tracerLogs: string[] = [];
	const originalConsoleLog = console.log;
	console.log = (...values: readonly unknown[]): void => {
		tracerLogs.push(values.map(String).join(" "));
	};
	try {
		await nodeFileTrace([entry]);
	} finally {
		console.log = originalConsoleLog;
	}
	assert(
		!tracerLogs.some((line) => line.startsWith("Globbing /etc")),
		"The deployment tracer must reject build-host system globs before filesystem enumeration",
	);
}
