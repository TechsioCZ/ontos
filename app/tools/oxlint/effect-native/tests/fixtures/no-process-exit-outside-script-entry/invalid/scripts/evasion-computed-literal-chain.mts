// expect-count: 2
// Evasion probe: computed access on both the global object and the member.
export const halt = (code: number): void => {
	globalThis["process"]["exit"](code);
	global["process"].exitCode = code;
};
