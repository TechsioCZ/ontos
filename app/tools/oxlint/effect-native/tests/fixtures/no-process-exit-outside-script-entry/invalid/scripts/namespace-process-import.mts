// expect-count: 2
import * as nodeProcess from "node:process";

const shutdown = (code: number): void => {
	nodeProcess.kill(nodeProcess.pid, "SIGTERM");
	nodeProcess.exitCode = code;
};

export const cleanup = (): void => shutdown(1);
