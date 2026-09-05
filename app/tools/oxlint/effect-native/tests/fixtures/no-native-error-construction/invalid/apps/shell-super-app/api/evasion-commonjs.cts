// expect-count: 1
export const boom = (): never => {
	throw new Error("a .cts module is still Effect application code");
};
