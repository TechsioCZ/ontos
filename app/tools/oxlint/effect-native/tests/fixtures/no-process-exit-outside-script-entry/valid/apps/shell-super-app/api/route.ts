// Outside scripts/**: this rule owns only the script executable edge.
export const shutdownHandler = (): void => {
	process.exitCode = 1;
	process.exit(1);
};
