// App-local `scripts/` directory: A8 owns bringing scripts under gates, and B3 keeps one small
// process-exit adapter at the executable edge.
export const report = (error: unknown): string =>
	error instanceof Error ? error.message : "Unknown stage demo bootstrap failure";

export const fail = (message: string): never => {
	throw new Error(message);
};
