// expect-count: 1
// Evasion probe: the process module bound by a dynamic import instead of a static one.
const nodeProcess = await import("node:process");

export const halt = (code: number): void => {
	nodeProcess.exit(code);
};
