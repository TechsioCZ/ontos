// expect-count: 2
// Policy boundary: oxlint.config.ts allows successful operational output; audit B3/A6 targets diagnostic logging.
// Optional chaining through the container global, computed string keys, and a template-literal key.
export function emit(message: string): void {
	globalThis?.console?.log?.(message);
	process?.stdout?.write?.(message);
	globalThis["console"]["error"](message);
	console?.[`warn`](message);
}
