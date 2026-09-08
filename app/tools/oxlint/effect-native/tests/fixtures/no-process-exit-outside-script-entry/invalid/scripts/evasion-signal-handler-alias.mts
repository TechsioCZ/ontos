// expect-count: 2
// Evasion probe: signal handlers registered through a default import alias and through
// `globalThis.process`, with the exit buried in a nested callback.
import nodeProcess from "node:process";

nodeProcess.prependOnceListener("SIGHUP", () => {
	setTimeout(() => {
		nodeProcess.exit(0);
	}, 10);
});

globalThis.process.on("SIGQUIT", async (): Promise<void> => {
	await Promise.resolve();
	process.exitCode = 131;
});
