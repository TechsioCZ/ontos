// expect-count: 3
// Evasion probe: the exit function reached without being the direct callee.
const codes = { failure: 1 } as const;

export const halt = (): void => {
	(0, process.exit)(codes.failure);
	process.exit.call(null, codes.failure);
	Reflect.apply(process.exit, null, [codes.failure]);
};
