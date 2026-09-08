interface Completed {
	readonly exitCode: number | null;
}

export const summarise = (result: Completed, child: { readonly pid: number }): string => {
	if (result.exitCode !== 0) return "failed";
	if (process.exitCode !== undefined) return "already decided";
	// Signalling a child process is resource management, not this process' exit decision.
	process.kill(child.pid, "SIGTERM");
	return "ok";
};

// A local binding named `process` shadows the global and is not the process object.
export const shim = (process: { readonly exit: (code: number) => void }): void => {
	process.exit(1);
};
